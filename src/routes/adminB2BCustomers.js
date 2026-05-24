// Admin "My B2B Customers" report — a focused view of the B2B customer
// base for the sales / ops admin to extract, filter, and export.
//
// Differences from /customer-report:
//   - Always scoped to customer_type='B2B' (B2C never appears here).
//   - Separate `business_name` and `gstin` filter inputs (not a single
//     blob search) — matches the BA-flavoured ask of "extract by
//     business name and GST number".
//   - Date range filters the per-customer ORDER COUNT only, not the
//     customer list itself. A B2B customer with zero orders in the
//     range still shows up with orders_in_range=0 so the admin can
//     spot churn/inactive accounts at a glance.
//
// Gated on the 'reports' permission so it inherits alongside the rest
// of the reporting suite.
//
// Mounted at /api/admin/b2b-customers.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requirePermission, customerB2BScopeWhere, orderB2BScopeWhere } from '../middleware/adminAuth.js';
import { sendXlsx, sendPdf } from '../lib/exports.js';

const router = Router();

const toNum = (d) => (d == null ? 0 : Number(d));

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
  const businessName = (query.business_name || '').toString().trim().toLowerCase();
  const gstin = (query.gstin || '').toString().trim().toLowerCase();
  // Sort: orders_in_range and total_sales drive the most useful default
  // views ("biggest by revenue", "most active this period"). Name + GSTIN
  // are alphabetical fallbacks for spreadsheet-style scanning.
  const allowedSort = ['orders_in_range', 'total_sales', 'business_name', 'gstin', 'total_orders'];
  const sort = allowedSort.includes(query.sort) ? query.sort : 'total_sales';
  return { from, to, businessName, gstin, sort };
}

function matchesFilters(row, businessName, gstin) {
  if (businessName) {
    const bn = (row.business_name || '').toLowerCase();
    // Also match the contact name as a fallback — B2B customers sometimes
    // get filed under a proprietor's name when their business_name field
    // is left empty.
    const fn = (row.full_name || '').toLowerCase();
    if (!bn.includes(businessName) && !fn.includes(businessName)) return false;
  }
  if (gstin) {
    const g = (row.gstin || '').toLowerCase();
    if (!g.includes(gstin)) return false;
  }
  return true;
}

async function buildReport(filters, admin) {
  const { from, to, businessName, gstin, sort } = filters;

  // B2B-scoped admin sees their own row only. Spread the scope into
  // both the customer list query and the orders rollups so totals
  // and exports stay consistent with the page.
  const scopeOnCustomer = customerB2BScopeWhere(admin);
  const scopeOnFk = orderB2BScopeWhere(admin);

  // The customer list is ALWAYS the full B2B set — the date filter only
  // narrows the orders count. This lets the admin see who's gone quiet
  // (orders_in_range=0) alongside who's active.
  const customers = await prisma.customer.findMany({
    where: { customer_type: 'B2B', ...scopeOnCustomer },
    select: {
      customer_id: true, full_name: true, email: true, phone: true,
      business_name: true, gstin: true,
      account_status: true, created_at: true,
    },
  });

  // Two parallel queries: lifetime non-cancelled order count, and the
  // count within the date window (if a range was provided). Splitting
  // lets the table show both columns without re-grouping client-side.
  const ordersDateWhere = (from || to) ? {
    order_date: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  } : {};

  const [allOrders, rangeOrders] = await Promise.all([
    prisma.order.findMany({
      where: {
        order_status: { not: 'Cancelled' },
        customer: { customer_type: 'B2B' },
        ...scopeOnFk,
      },
      select: { customer_id: true, total_amount: true },
    }),
    (from || to)
      ? prisma.order.findMany({
          where: {
            order_status: { not: 'Cancelled' },
            customer: { customer_type: 'B2B' },
            ...ordersDateWhere,
            ...scopeOnFk,
          },
          select: { customer_id: true, total_amount: true },
        })
      : Promise.resolve(null),
  ]);

  // Lifetime rollup (always computed).
  const lifetimeByCustomer = new Map();
  for (const o of allOrders) {
    const row = lifetimeByCustomer.get(o.customer_id) || { count: 0, sales: 0 };
    row.count += 1;
    row.sales += toNum(o.total_amount);
    lifetimeByCustomer.set(o.customer_id, row);
  }

  // Date-range rollup. When no range is set, the values fall back to
  // the lifetime numbers so the table column stays meaningful — the
  // admin can think of "orders in range" as "orders in the selected
  // window OR all-time if no window".
  const rangeByCustomer = new Map();
  const rangeSource = rangeOrders || allOrders;
  for (const o of rangeSource) {
    const row = rangeByCustomer.get(o.customer_id) || { count: 0, sales: 0 };
    row.count += 1;
    row.sales += toNum(o.total_amount);
    rangeByCustomer.set(o.customer_id, row);
  }

  let rows = customers.map((c) => {
    const life = lifetimeByCustomer.get(c.customer_id) || { count: 0, sales: 0 };
    const range = rangeByCustomer.get(c.customer_id) || { count: 0, sales: 0 };
    return {
      customer_id: c.customer_id,
      full_name: c.full_name,
      business_name: c.business_name,
      gstin: c.gstin,
      email: c.email,
      phone: c.phone,
      account_status: c.account_status,
      created_at: c.created_at,
      total_orders: life.count,
      total_sales: life.sales,
      orders_in_range: range.count,
      sales_in_range: range.sales,
    };
  });

  rows = rows.filter((r) => matchesFilters(r, businessName, gstin));

  rows.sort((a, b) => {
    if (sort === 'business_name') return (a.business_name || a.full_name || '').localeCompare(b.business_name || b.full_name || '');
    if (sort === 'gstin') return (a.gstin || '').localeCompare(b.gstin || '');
    if (sort === 'total_orders') return b.total_orders - a.total_orders;
    if (sort === 'orders_in_range') return b.orders_in_range - a.orders_in_range;
    return b.total_sales - a.total_sales; // default 'total_sales'
  });

  const totals = rows.reduce((acc, r) => {
    acc.total_sales += r.total_sales;
    acc.total_orders += r.total_orders;
    acc.orders_in_range += r.orders_in_range;
    acc.sales_in_range += r.sales_in_range;
    return acc;
  }, { customers: 0, total_sales: 0, total_orders: 0, orders_in_range: 0, sales_in_range: 0 });
  totals.customers = rows.length;

  return {
    rows,
    totals,
    filters_applied: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
      business_name: businessName || null,
      gstin: gstin || null,
      sort,
    },
    date_range_active: !!(from || to),
  };
}

// GET /api/admin/b2b-customers
router.get('/', requirePermission('b2b-customers'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const data = await buildReport(filters, req.admin);
  res.json({ data });
}));

function describeFilters(applied) {
  const bits = [];
  if (applied.from || applied.to) bits.push(`Orders date: ${applied.from || '…'} to ${applied.to || '…'}`);
  if (applied.business_name) bits.push(`Business: "${applied.business_name}"`);
  if (applied.gstin) bits.push(`GSTIN: "${applied.gstin}"`);
  return bits.length ? bits.join(' · ') : 'No filters applied';
}

// GET /api/admin/b2b-customers/export?format=xlsx|pdf&...filters
router.get('/export', requirePermission('b2b-customers'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'format must be xlsx or pdf' });
  }
  const data = await buildReport(filters, req.admin);
  const filtersLine = describeFilters(data.filters_applied);
  const stamp = new Date().toISOString().slice(0, 10);

  // Column set mirrors the on-screen table; the range column is included
  // even when no range was selected (falls back to lifetime values) so
  // the downloaded report self-documents the scope via the summary line.
  const columns = [
    { key: 'business_name', header: 'Business name', width: 28 },
    { key: 'gstin', header: 'GSTIN', width: 18 },
    { key: 'full_name', header: 'Contact', width: 22 },
    { key: 'email', header: 'Email', width: 26 },
    { key: 'phone', header: 'Phone', width: 14 },
    { key: 'orders_in_range', header: data.date_range_active ? 'Orders (in range)' : 'Orders (all-time)', format: 'number', width: 14 },
    { key: 'sales_in_range', header: data.date_range_active ? 'Sales (in range)' : 'Sales (all-time)', format: 'currency', width: 16 },
    { key: 'total_orders', header: 'Lifetime orders', format: 'number', width: 14 },
    { key: 'total_sales', header: 'Lifetime sales', format: 'currency', width: 16 },
    { key: 'account_status', header: 'Status', width: 10 },
  ];
  const summary = [
    { label: 'Filters', value: filtersLine },
    { label: 'B2B customers', value: data.totals.customers },
    { label: data.date_range_active ? 'Orders (in range)' : 'Orders (all-time)', value: data.totals.orders_in_range },
    { label: data.date_range_active ? 'Sales (in range)' : 'Sales (all-time)', value: data.totals.sales_in_range },
    { label: 'Lifetime orders', value: data.totals.total_orders },
    { label: 'Lifetime sales', value: data.totals.total_sales },
    { label: 'Generated', value: new Date().toISOString() },
  ];
  const opts = {
    sheetName: 'My B2B customers',
    columns,
    rows: data.rows,
    filename: `b2b_customers_${stamp}`,
    title: 'Redlook — My B2B Customers',
    subtitle: filtersLine,
    summary,
  };
  if (format === 'xlsx') return sendXlsx(res, opts);
  return sendPdf(res, opts);
}));

export default router;
