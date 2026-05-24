// Admin "Customer Report" — per-customer accountability view.
//
// One row per customer with: total sales, total orders, quantity sold
// (broken down by unit), credit outstanding, and (for B2B) the credit
// limit / utilisation. Built as a sibling of /credit/accounting but
// scoped to "who owes / who bought what" rather than "what's overdue".
//
// Gated on the 'reports' permission so finance / ops roles inherit it
// alongside Accounting and Reports.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requirePermission, customerB2BScopeWhere, orderB2BScopeWhere, nestedCustomerB2BScopeWhere } from '../middleware/adminAuth.js';
import { sendXlsx, sendPdf } from '../lib/exports.js';

const router = Router();

const toNum = (d) => (d == null ? 0 : Number(d));
const CUSTOMER_TYPES = ['B2B', 'B2C'];

function parseDateParam(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}

function readFilters(query) {
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);
  if (to) to.setHours(23, 59, 59, 999);
  const customerType = CUSTOMER_TYPES.includes(query.customer_type) ? query.customer_type : null;
  const search = (query.search || '').toString().trim().toLowerCase();
  const hasOutstanding = query.has_outstanding === '1' || query.has_outstanding === 'true';
  const hasCreditLimit = query.has_credit_limit === '1' || query.has_credit_limit === 'true';
  const sort = ['sales', 'outstanding', 'name', 'orders'].includes(query.sort) ? query.sort : 'sales';
  return { from, to, customerType, search, hasOutstanding, hasCreditLimit, sort };
}

function matchesSearch(row, search) {
  if (!search) return true;
  return [row.full_name, row.business_name, row.email, row.phone]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(search));
}

// Format the per-unit quantity map into one human string. Used by both
// the JSON view and the export columns so the renderings agree.
function formatQuantityByUnit(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => Number(v) > 0);
  if (entries.length === 0) return '—';
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries
    .map(([u, q]) => `${Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${u}`)
    .join(' · ');
}

async function buildCustomerReport(filters, admin) {
  const { from, to, customerType, search, hasOutstanding, hasCreditLimit, sort } = filters;

  const customerTypeWhere = customerType ? { customer_type: customerType } : {};
  // B2B scope: collapses every query to the admin's linked customer.
  // Spread alongside the existing customerType filter — both clauses AND.
  const scopeOnCustomer = customerB2BScopeWhere(admin);   // { customer_id: id } on Customer
  const scopeOnFk = orderB2BScopeWhere(admin);            // same shape, used on rows that store customer_id directly
  const scopeNested = nestedCustomerB2BScopeWhere(admin); // { customer: { customer_id: id } } for nested filters
  const ordersDateWhere = (from || to) ? {
    order_date: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  } : {};

  const [customers, orders, items, creditConfigs, openDebits] = await Promise.all([
    prisma.customer.findMany({
      where: { ...customerTypeWhere, ...scopeOnCustomer },
      select: {
        customer_id: true, full_name: true, email: true, phone: true,
        customer_type: true, business_name: true, gstin: true,
        account_status: true, created_at: true,
      },
    }),
    prisma.order.findMany({
      where: {
        order_status: { not: 'Cancelled' },
        ...ordersDateWhere,
        ...(customerType ? { customer: { customer_type: customerType } } : {}),
        ...scopeOnFk,
      },
      select: { order_id: true, customer_id: true, total_amount: true },
    }),
    // OrderItem rows for the orders in scope. The reverse-direction filter
    // (item.order.is...) lets us scope by order_status / date / customer_type
    // in a single query.
    prisma.orderItem.findMany({
      where: {
        order: {
          order_status: { not: 'Cancelled' },
          ...ordersDateWhere,
          ...(customerType ? { customer: { customer_type: customerType } } : {}),
          ...scopeOnFk,
        },
      },
      select: {
        unit: true, quantity: true,
        order: { select: { customer_id: true } },
      },
    }),
    prisma.customerCreditConfig.findMany({
      where: {
        ...(customerType ? { customer: { customer_type: customerType } } : {}),
        ...scopeOnFk,
      },
      select: {
        customer_id: true, credit_enabled: true, credit_limit: true,
        payment_terms_days: true, status: true,
      },
    }),
    prisma.creditTransaction.findMany({
      where: {
        type: 'DEBIT',
        status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
        ...(customerType ? { customer: { customer_type: customerType } } : {}),
        ...scopeOnFk,
      },
      select: { customer_id: true, amount: true, amount_paid: true },
    }),
  ]);

  // Build per-customer maps for the three rollups.
  const salesByCustomer = new Map();
  for (const o of orders) {
    const row = salesByCustomer.get(o.customer_id) || { total_sales: 0, total_orders: 0 };
    row.total_sales += toNum(o.total_amount);
    row.total_orders += 1;
    salesByCustomer.set(o.customer_id, row);
  }

  const quantityByCustomer = new Map();
  for (const it of items) {
    const cid = it.order?.customer_id;
    if (!cid) continue;
    const unit = (it.unit || '').trim().toLowerCase() || 'unit';
    const m = quantityByCustomer.get(cid) || {};
    m[unit] = (m[unit] || 0) + toNum(it.quantity);
    quantityByCustomer.set(cid, m);
  }

  const outstandingByCustomer = new Map();
  for (const d of openDebits) {
    const owed = toNum(d.amount) - toNum(d.amount_paid);
    if (owed <= 0) continue;
    outstandingByCustomer.set(
      d.customer_id,
      (outstandingByCustomer.get(d.customer_id) || 0) + owed,
    );
  }

  const creditByCustomer = new Map(
    creditConfigs.map((c) => [c.customer_id, c]),
  );

  // Merge into a flat per-customer row.
  let rows = customers.map((c) => {
    const s = salesByCustomer.get(c.customer_id) || { total_sales: 0, total_orders: 0 };
    const q = quantityByCustomer.get(c.customer_id) || {};
    const outstanding = outstandingByCustomer.get(c.customer_id) || 0;
    const cfg = creditByCustomer.get(c.customer_id);
    const creditLimit = cfg ? toNum(cfg.credit_limit) : 0;
    const creditAssigned = !!cfg && cfg.credit_enabled && creditLimit > 0;
    const utilisationPct = creditLimit > 0
      ? Math.round((outstanding / creditLimit) * 100)
      : null;
    return {
      customer_id: c.customer_id,
      full_name: c.full_name,
      email: c.email,
      phone: c.phone,
      customer_type: c.customer_type,
      business_name: c.business_name,
      gstin: c.gstin,
      account_status: c.account_status,
      total_sales: s.total_sales,
      total_orders: s.total_orders,
      quantity_by_unit: q,
      quantity_display: formatQuantityByUnit(q),
      outstanding,
      credit_enabled: !!cfg?.credit_enabled,
      credit_assigned: creditAssigned,
      credit_limit: creditLimit,
      payment_terms_days: cfg?.payment_terms_days ?? null,
      credit_status: cfg?.status ?? null,
      utilisation_pct: utilisationPct,
      available_credit: creditLimit > 0 ? Math.max(0, creditLimit - outstanding) : 0,
    };
  });

  if (search) rows = rows.filter((r) => matchesSearch(r, search));
  if (hasOutstanding) rows = rows.filter((r) => r.outstanding > 0);
  if (hasCreditLimit) rows = rows.filter((r) => r.credit_assigned);

  rows.sort((a, b) => {
    if (sort === 'name') return a.full_name.localeCompare(b.full_name);
    if (sort === 'outstanding') return b.outstanding - a.outstanding;
    if (sort === 'orders') return b.total_orders - a.total_orders;
    return b.total_sales - a.total_sales; // default 'sales'
  });

  const totals = rows.reduce((acc, r) => {
    acc.total_sales += r.total_sales;
    acc.total_orders += r.total_orders;
    acc.total_outstanding += r.outstanding;
    acc.total_credit_limit += r.credit_limit;
    for (const [u, q] of Object.entries(r.quantity_by_unit)) {
      acc.quantity_by_unit[u] = (acc.quantity_by_unit[u] || 0) + q;
    }
    if (r.credit_assigned) acc.customers_with_credit += 1;
    if (r.outstanding > 0) acc.customers_with_outstanding += 1;
    return acc;
  }, {
    customers: 0,
    total_sales: 0,
    total_orders: 0,
    total_outstanding: 0,
    total_credit_limit: 0,
    customers_with_credit: 0,
    customers_with_outstanding: 0,
    quantity_by_unit: {},
  });
  totals.customers = rows.length;

  return {
    rows,
    totals,
    filters_applied: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
      customer_type: customerType,
      search: search || null,
      has_outstanding: hasOutstanding,
      has_credit_limit: hasCreditLimit,
      sort,
    },
  };
}

// GET /api/admin/customer-report
router.get('/', requirePermission('customer-report'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const data = await buildCustomerReport(filters, req.admin);
  res.json({ data });
}));

function describeFilters(applied) {
  const bits = [];
  if (applied.from || applied.to) bits.push(`Date: ${applied.from || '…'} to ${applied.to || '…'}`);
  if (applied.customer_type) bits.push(`Type: ${applied.customer_type}`);
  if (applied.has_outstanding) bits.push('Outstanding only');
  if (applied.has_credit_limit) bits.push('Credit assigned only');
  if (applied.search) bits.push(`Search: "${applied.search}"`);
  return bits.length ? bits.join(' · ') : 'No filters applied';
}

// GET /api/admin/customer-report/export?format=xlsx|pdf&...filters
router.get('/export', requirePermission('customer-report'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'format must be xlsx or pdf' });
  }
  const data = await buildCustomerReport(filters, req.admin);
  const filtersLine = describeFilters(data.filters_applied);
  const stamp = new Date().toISOString().slice(0, 10);

  const columns = [
    { key: 'full_name', header: 'Customer', width: 26 },
    { key: 'business_name', header: 'Business', width: 24 },
    { key: 'customer_type', header: 'Type', width: 8 },
    { key: 'email', header: 'Email', width: 26 },
    { key: 'phone', header: 'Phone', width: 14 },
    { key: 'total_orders', header: 'Orders', format: 'number', width: 10 },
    { key: 'total_sales', header: 'Total sales', format: 'currency', width: 16 },
    { key: 'quantity_display', header: 'Quantity sold', width: 24 },
    { key: 'outstanding', header: 'Outstanding', format: 'currency', width: 16 },
    { key: 'credit_limit', header: 'Credit limit', format: 'currency', width: 14 },
    { key: 'utilisation_pct', header: 'Used %', format: 'number', width: 10 },
    { key: 'available_credit', header: 'Available', format: 'currency', width: 14 },
    { key: 'payment_terms_days', header: 'Terms (d)', format: 'number', width: 10 },
  ];
  const summary = [
    { label: 'Filters', value: filtersLine },
    { label: 'Customers', value: data.totals.customers },
    { label: 'Total sales', value: data.totals.total_sales },
    { label: 'Total orders', value: data.totals.total_orders },
    { label: 'Quantity sold', value: formatQuantityByUnit(data.totals.quantity_by_unit) },
    { label: 'Total outstanding', value: data.totals.total_outstanding },
    { label: 'Total credit limit (B2B)', value: data.totals.total_credit_limit },
    { label: 'Customers with credit', value: data.totals.customers_with_credit },
    { label: 'Customers with outstanding', value: data.totals.customers_with_outstanding },
    { label: 'Generated', value: new Date().toISOString() },
  ];
  const opts = {
    sheetName: 'Customer report',
    columns,
    rows: data.rows,
    filename: `customer_report_${stamp}`,
    title: 'Redlook — Customer Report',
    subtitle: filtersLine,
    summary,
  };
  if (format === 'xlsx') return sendXlsx(res, opts);
  return sendPdf(res, opts);
}));

export default router;
