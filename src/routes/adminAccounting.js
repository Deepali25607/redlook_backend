// Admin "Accounting" view — aggregate credit data across all customers
// (BRD §6). Read-only. Built on top of the same primitives in lib/credit.js
// that drive the per-customer ledger, so a number on this dashboard always
// matches what the admin would see drilling into that customer.
//
// Gated on the 'reports' permission — finance/operations roles already
// have it; Support reps don't. If a dedicated 'accounting' permission is
// added later, swap requirePermission here and add it to PERMISSION_DEFINITIONS.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requirePermission, orderB2BScopeWhere, nestedCustomerB2BScopeWhere } from '../middleware/adminAuth.js';
import { notify } from '../lib/notify.js';
import { sendXlsx, sendPdf } from '../lib/exports.js';

const router = Router();

const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));
const toNum = (d) => (d == null ? 0 : Number(d));

// Bucket boundaries match the BRD §6 ageing breakdown exactly.
function bucketForOverdueDays(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

// Parse a YYYY-MM-DD query param into a Date at the start of the day, or
// null if absent / malformed. Avoids timezone-shifted "off by one day"
// surprises when the admin types 2026-05-10 in Asia/Kolkata.
function parseDateParam(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}

const PAYMENT_MODES = ['BANK_TRANSFER', 'CHEQUE', 'UPI', 'CASH', 'CARD'];
const CUSTOMER_TYPES = ['B2B', 'B2C'];
const STATUS_FILTERS = ['all', 'with_outstanding', 'overdue_only'];

// Read & normalise the filter set used by both the JSON view and the
// export endpoints, so a download exactly mirrors what's on screen.
function readFilters(query) {
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);
  // End-of-day for the upper bound — otherwise typing "to=2026-05-10" would
  // exclude any payment on the 10th itself.
  if (to) to.setHours(23, 59, 59, 999);
  const customerType = CUSTOMER_TYPES.includes(query.customer_type) ? query.customer_type : null;
  const paymentMode = PAYMENT_MODES.includes(query.payment_mode) ? query.payment_mode : null;
  const search = (query.search || '').toString().trim().toLowerCase();
  const statusFilter = STATUS_FILTERS.includes(query.status_filter) ? query.status_filter : 'all';
  return { from, to, customerType, paymentMode, search, statusFilter };
}

// Match a customer row (or any object with full_name / business_name /
// email fields) against the search term. Empty term matches everything.
function matchesSearch(row, search) {
  if (!search) return true;
  return [row.full_name, row.business_name, row.email]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(search));
}

// GET /api/admin/credit/accounting
// One round-trip for the entire Accounting page. Computes everything in
// a single pass over the unpaid DEBIT rows so a 1000-customer DB stays
// fast — the per-customer state helper would N+1 the same query.
// Internal worker — computes the accounting payload for a given filter set.
// Both the JSON view and the export endpoints delegate here so a download
// matches the on-screen view byte-for-byte.
async function buildAccountingReport(filters, admin) {
  const { from, to, customerType, paymentMode, search, statusFilter } = filters;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Customer-type filter is push-down to the DB via a `customer.is` clause
  // — saves shipping rows we'd just discard in JS. Search/status are
  // applied in JS because they need post-rollup figures (outstanding,
  // overdue) to evaluate.
  const customerTypeWhere = customerType
    ? { customer: { customer_type: customerType } }
    : {};

  // B2B-scoped admin → restrict everything to their linked customer's
  // rows. Spread into each query alongside the existing customerType
  // filter; both clauses AND together at the DB. Empty object when
  // unscoped (no-op spread).
  const b2bScopeWhere = orderB2BScopeWhere(admin);
  const b2bScopeNestedWhere = nestedCustomerB2BScopeWhere(admin);

  // For the recent payments list, the date range filters by payment_date.
  // For the trend, we use the same range when provided, otherwise fall
  // back to "last 30 days from today" for backwards compatibility.
  const paymentDateWhere = (from || to) ? {
    payment_date: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  } : {};

  const paymentModeWhere = paymentMode ? { mode: paymentMode } : {};

  // Sales rollup uses the same date window as payments (treated as
  // `order_date`) and respects customer_type, so the "Sales" tiles
  // move in sync with the credit tiles when an admin scopes the page
  // to a quarter / a customer segment. Cancelled orders are excluded
  // — they never produced revenue.
  const ordersDateWhere = (from || to) ? {
    order_date: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  } : {};

  const [debits, payments, configs, recentPaymentsRaw, salesOrders, quantityRollup] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: {
        type: 'DEBIT',
        status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
        ...customerTypeWhere,
        ...b2bScopeWhere,
      },
      include: {
        customer: {
          select: {
            customer_id: true, full_name: true, email: true, phone: true,
            customer_type: true, business_name: true,
          },
        },
      },
    }),
    prisma.creditTransaction.findMany({
      where: { type: 'CREDIT', ...b2bScopeWhere },
      select: { amount: true, created_at: true },
    }),
    prisma.customerCreditConfig.findMany({
      where: {
        credit_enabled: true,
        ...customerTypeWhere,
        ...b2bScopeWhere,
      },
      include: {
        customer: {
          select: {
            customer_id: true, full_name: true, email: true, phone: true,
            customer_type: true, business_name: true,
          },
        },
      },
    }),
    // Payments-received list — applies date / mode / customer-type / search
    // filters before sorting by date desc.
    prisma.paymentReceived.findMany({
      where: {
        ...paymentDateWhere,
        ...paymentModeWhere,
        ...customerTypeWhere,
        ...b2bScopeWhere,
      },
      orderBy: { payment_date: 'desc' },
      take: 500, // generous cap so a date-range export is complete
      include: {
        customer: {
          select: {
            customer_id: true, full_name: true,
            customer_type: true, business_name: true,
          },
        },
      },
    }),
    prisma.order.findMany({
      where: {
        order_status: { not: 'Cancelled' },
        ...ordersDateWhere,
        ...customerTypeWhere,
        ...b2bScopeWhere,
      },
      select: {
        total_amount: true,
        payment_method: true,
        customer: { select: { customer_type: true } },
      },
    }),
    // Quantity rollup — grouped by `unit` because kg + pcs + g can't be
    // summed into a single meaningful figure. One DB-side groupBy keeps
    // the per-unit totals cheap even with thousands of line items.
    prisma.orderItem.groupBy({
      by: ['unit'],
      where: {
        order: {
          order_status: { not: 'Cancelled' },
          ...ordersDateWhere,
          ...customerTypeWhere,
          ...b2bScopeWhere,
        },
      },
      _sum: { quantity: true },
      _count: { _all: true },
    }),
  ]);

  // Sales totals — gross of non-cancelled orders, with the same
  // customer_type / date scope the rest of the page uses.
  let totalSales = 0;
  let salesB2B = 0;
  let salesB2C = 0;
  const salesByPaymentMethod = {};
  for (const o of salesOrders) {
    const amt = toNum(o.total_amount);
    totalSales += amt;
    if (o.customer?.customer_type === 'B2B') salesB2B += amt;
    else salesB2C += amt;
    const m = (o.payment_method || 'OTHER').toUpperCase();
    salesByPaymentMethod[m] = (salesByPaymentMethod[m] || 0) + amt;
  }

  // Quantity by unit + a flat line-items count. Units are normalised
  // (trim/lowercase) so "Kg" and "kg" don't end up in different keys.
  const quantityByUnit = {};
  let totalLineItems = 0;
  for (const row of quantityRollup) {
    const unit = (row.unit || '').trim().toLowerCase() || 'unit';
    const qty = toNum(row._sum?.quantity);
    quantityByUnit[unit] = (quantityByUnit[unit] || 0) + qty;
    totalLineItems += row._count?._all || 0;
  }

  // Per-customer rollup. Walk the unpaid debits once.
  const byCustomer = new Map();
  for (const cfg of configs) {
    byCustomer.set(cfg.customer_id, {
      customer_id: cfg.customer_id,
      full_name: cfg.customer.full_name,
      email: cfg.customer.email,
      phone: cfg.customer.phone,
      customer_type: cfg.customer.customer_type,
      business_name: cfg.customer.business_name,
      credit_limit: toNum(cfg.credit_limit),
      payment_terms_days: cfg.payment_terms_days,
      credit_enabled: cfg.credit_enabled,
      status: cfg.status,
      outstanding: 0,
      overdue_amount: 0,
      oldest_overdue_date: null,
      oldest_overdue_days: 0,
      pending_invoice_count: 0,
    });
  }

  let totalOutstandingB2B = 0;
  let totalOutstandingB2C = 0;
  const ageing = { current: 0, '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };

  for (const d of debits) {
    const owed = toNum(d.amount) - toNum(d.amount_paid);
    if (owed <= 0) continue;
    const customerType = d.customer.customer_type;
    if (customerType === 'B2B') totalOutstandingB2B += owed;
    else totalOutstandingB2C += owed;

    const dueDays = d.due_date
      ? Math.floor((today - new Date(d.due_date)) / 86_400_000)
      : 0;
    ageing[bucketForOverdueDays(dueDays)] += owed;

    let row = byCustomer.get(d.customer_id);
    if (!row) {
      // Customer might have no credit_config row (a manual ADJUSTMENT
      // could have created the DEBIT). Synthesize a minimal row so the
      // table still shows them.
      row = {
        customer_id: d.customer_id,
        full_name: d.customer.full_name,
        email: d.customer.email,
        phone: d.customer.phone,
        customer_type: customerType,
        business_name: d.customer.business_name,
        credit_limit: 0,
        payment_terms_days: 0,
        credit_enabled: false,
        status: 'inactive',
        outstanding: 0,
        overdue_amount: 0,
        oldest_overdue_date: null,
        oldest_overdue_days: 0,
        pending_invoice_count: 0,
      };
      byCustomer.set(d.customer_id, row);
    }
    row.outstanding += owed;
    row.pending_invoice_count += 1;
    if (dueDays > 0) {
      row.overdue_amount += owed;
      if (!row.oldest_overdue_date || new Date(d.due_date) < new Date(row.oldest_overdue_date)) {
        row.oldest_overdue_date = d.due_date;
        row.oldest_overdue_days = dueDays;
      }
    }
  }

  // Available + utilisation_pct now that outstanding is summed.
  let customers = [...byCustomer.values()].map((row) => {
    const available = Math.max(0, row.credit_limit - row.outstanding);
    const utilisationPct = row.credit_limit > 0
      ? Math.round((row.outstanding / row.credit_limit) * 100)
      : null;
    return { ...row, available, utilisation_pct: utilisationPct };
  });

  // Apply post-rollup filters that need outstanding/overdue figures.
  if (statusFilter === 'with_outstanding') {
    customers = customers.filter((c) => c.outstanding > 0);
  } else if (statusFilter === 'overdue_only') {
    customers = customers.filter((c) => c.overdue_amount > 0);
  }
  if (search) customers = customers.filter((c) => matchesSearch(c, search));

  // Sort by outstanding desc — biggest exposures float to the top.
  customers.sort((a, b) => b.outstanding - a.outstanding);

  // Alerts (BRD §6 — "exceeded 80% of limit" + "overdue > 30 days").
  const alerts = {
    high_utilisation: customers.filter((c) => c.utilisation_pct != null && c.utilisation_pct >= 80),
    long_overdue: customers.filter((c) => c.oldest_overdue_days > 30),
  };

  // Daily trend — when a date range is supplied use that window, otherwise
  // fall back to "last 30 days from today" for the default dashboard view.
  const trendStart = from ? new Date(from) : (() => { const s = new Date(); s.setDate(s.getDate() - 29); s.setHours(0,0,0,0); return s; })();
  const trendEnd = to ? new Date(to) : (() => { const e = new Date(); e.setHours(23,59,59,999); return e; })();
  // Cap the chart at 90 days to keep the bar density readable.
  const trendDays = Math.min(90, Math.max(1, Math.ceil((trendEnd - trendStart) / 86_400_000) + 1));
  const allDebitsTrend = await prisma.creditTransaction.findMany({
    where: {
      type: 'DEBIT',
      created_at: { gte: trendStart, lte: trendEnd },
      ...customerTypeWhere,
      ...b2bScopeWhere,
    },
    select: { amount: true, created_at: true },
  });
  const trendMap = new Map();
  for (let i = 0; i < trendDays; i++) {
    const d = new Date(trendStart);
    d.setDate(trendStart.getDate() + i);
    trendMap.set(d.toISOString().slice(0, 10), { disbursed: 0, collected: 0 });
  }
  for (const d of allDebitsTrend) {
    const key = new Date(d.created_at).toISOString().slice(0, 10);
    if (trendMap.has(key)) trendMap.get(key).disbursed += toNum(d.amount);
  }
  for (const p of payments) {
    const key = new Date(p.created_at).toISOString().slice(0, 10);
    if (trendMap.has(key)) trendMap.get(key).collected += toNum(p.amount);
  }
  const trend = [...trendMap.entries()].map(([date, v]) => ({ date, ...v }));

  // Per-payment rows for the "Payments received" section. Date-sorted desc.
  // Applies the same search filter so a name typed in the filter bar
  // narrows the payments list too.
  let recent_payments = recentPaymentsRaw.map((p) => ({
    id: p.id,
    amount: toNum(p.amount),
    payment_date: p.payment_date,
    mode: p.mode,
    reference_no: p.reference_no,
    notes: p.notes,
    customer_id: p.customer.customer_id,
    customer_name: p.customer.full_name,
    customer_type: p.customer.customer_type,
    business_name: p.customer.business_name,
  }));
  if (search) {
    recent_payments = recent_payments.filter((p) =>
      matchesSearch({ full_name: p.customer_name, business_name: p.business_name }, search));
  }

  return {
    summary: {
      total_outstanding: totalOutstandingB2B + totalOutstandingB2C,
      outstanding_b2b: totalOutstandingB2B,
      outstanding_b2c: totalOutstandingB2C,
      total_overdue: ageing['0-30'] + ageing['31-60'] + ageing['61-90'] + ageing['90+'],
      total_credit_customers: configs.filter((c) => c.credit_enabled).length,
      total_payments_received: recent_payments.reduce((acc, p) => acc + p.amount, 0),
      total_sales: totalSales,
      sales_b2b: salesB2B,
      sales_b2c: salesB2C,
      total_orders: salesOrders.length,
      sales_by_payment_method: salesByPaymentMethod,
      quantity_by_unit: quantityByUnit,
      total_line_items: totalLineItems,
      sales_scope: (from || to) ? 'date_range' : 'all_time',
    },
    ageing,
    customers,
    alerts,
    trend,
    recent_payments,
    filters_applied: {
      from: from ? from.toISOString().slice(0, 10) : null,
      to: to ? to.toISOString().slice(0, 10) : null,
      customer_type: customerType,
      payment_mode: paymentMode,
      search: search || null,
      status_filter: statusFilter,
    },
  };
}

// GET /api/admin/credit/accounting?from=&to=&customer_type=&payment_mode=&search=&status_filter=
router.get('/accounting', requirePermission('accounting'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const data = await buildAccountingReport(filters, req.admin);
  res.json({ data });
}));

// Helper: build a one-line "Filters: …" summary for the export headers so
// the recipient of the file can tell at a glance which slice they got.
function describeFilters(applied) {
  const bits = [];
  if (applied.from || applied.to) bits.push(`Date: ${applied.from || '…'} to ${applied.to || '…'}`);
  if (applied.customer_type) bits.push(`Type: ${applied.customer_type}`);
  if (applied.payment_mode) bits.push(`Mode: ${applied.payment_mode.replace('_', ' ')}`);
  if (applied.search) bits.push(`Search: "${applied.search}"`);
  if (applied.status_filter && applied.status_filter !== 'all') {
    bits.push(`Status: ${applied.status_filter.replace('_', ' ')}`);
  }
  return bits.length ? bits.join(' · ') : 'No filters applied';
}

// GET /api/admin/credit/accounting/export?report=customers|payments&format=xlsx|pdf&...filters
// Same filter contract as the JSON view; outputs an Excel workbook or
// landscape A4 PDF using the shared exports lib.
router.get('/accounting/export', requirePermission('accounting'), asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const report = String(req.query.report || 'customers').toLowerCase();
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['customers', 'payments'].includes(report)) {
    return res.status(400).json({ error: 'report must be customers or payments' });
  }
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'format must be xlsx or pdf' });
  }

  const data = await buildAccountingReport(filters, req.admin);
  const filtersLine = describeFilters(data.filters_applied);
  const stamp = new Date().toISOString().slice(0, 10);

  if (report === 'customers') {
    const columns = [
      { key: 'full_name', header: 'Customer', width: 28 },
      { key: 'business_name', header: 'Business', width: 24 },
      { key: 'customer_type', header: 'Type', width: 8 },
      { key: 'email', header: 'Email', width: 28 },
      { key: 'credit_limit', header: 'Limit', format: 'currency', width: 14 },
      { key: 'outstanding', header: 'Outstanding', format: 'currency', width: 16 },
      { key: 'available', header: 'Available', format: 'currency', width: 14 },
      { key: 'utilisation_pct', header: 'Used %', format: 'number', width: 10 },
      { key: 'overdue_amount', header: 'Overdue', format: 'currency', width: 14 },
      { key: 'oldest_overdue_days', header: 'Oldest overdue (d)', format: 'number', width: 14 },
      { key: 'pending_invoice_count', header: 'Pending inv.', format: 'number', width: 12 },
    ];
    const summary = [
      { label: 'Filters', value: filtersLine },
      { label: 'Total sales', value: data.summary.total_sales },
      { label: 'Total orders', value: data.summary.total_orders },
      { label: 'Total line items', value: data.summary.total_line_items },
      { label: 'Quantity sold', value: Object.entries(data.summary.quantity_by_unit || {})
          .map(([u, q]) => `${Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${u}`)
          .join(' · ') || '—' },
      { label: 'B2B sales', value: data.summary.sales_b2b },
      { label: 'B2C sales', value: data.summary.sales_b2c },
      { label: 'Total outstanding', value: data.summary.total_outstanding },
      { label: 'B2B outstanding', value: data.summary.outstanding_b2b },
      { label: 'B2C outstanding', value: data.summary.outstanding_b2c },
      { label: 'Total overdue', value: data.summary.total_overdue },
      { label: 'Customers', value: data.customers.length },
      { label: 'Generated', value: new Date().toISOString() },
    ];
    const opts = {
      sheetName: 'Customers',
      columns,
      rows: data.customers,
      filename: `accounting_customers_${stamp}`,
      title: 'Redlook — Credit Customers',
      subtitle: filtersLine,
      summary,
    };
    if (format === 'xlsx') return sendXlsx(res, opts);
    return sendPdf(res, opts);
  }

  // report === 'payments'
  const rows = data.recent_payments.map((p) => ({
    payment_date: p.payment_date,
    customer_name: p.customer_type === 'B2B' && p.business_name ? p.business_name : p.customer_name,
    contact: p.customer_type === 'B2B' && p.business_name ? p.customer_name : '',
    customer_type: p.customer_type,
    mode: p.mode.replace('_', ' '),
    reference_no: p.reference_no || '',
    amount: p.amount,
    notes: p.notes || '',
  }));
  const columns = [
    { key: 'payment_date', header: 'Date', format: 'date', width: 14 },
    { key: 'customer_name', header: 'Customer / Business', width: 28 },
    { key: 'contact', header: 'Contact', width: 22 },
    { key: 'customer_type', header: 'Type', width: 8 },
    { key: 'mode', header: 'Mode', width: 14 },
    { key: 'reference_no', header: 'Reference', width: 18 },
    { key: 'amount', header: 'Amount', format: 'currency', width: 14 },
    { key: 'notes', header: 'Notes', width: 30 },
  ];
  const summary = [
    { label: 'Filters', value: filtersLine },
    { label: 'Total received', value: data.summary.total_payments_received },
    { label: 'Payments', value: rows.length },
    { label: 'Generated', value: new Date().toISOString() },
  ];
  const opts = {
    sheetName: 'Payments',
    columns,
    rows,
    filename: `accounting_payments_${stamp}`,
    title: 'Redlook — Payments Received',
    subtitle: filtersLine,
    summary,
  };
  if (format === 'xlsx') return sendXlsx(res, opts);
  return sendPdf(res, opts);
}));

// POST /api/admin/credit/accounting/bulk-remind
// Fires payment-overdue notifications to every customer with at least
// one overdue invoice. Best-effort, fire-and-forget per recipient so a
// dead address can't block the others. Returns the count of customers
// targeted (not the count of channels successfully delivered — that's
// downstream of the providers).
router.post('/accounting/bulk-remind', requirePermission('accounting'), asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Scoped admins reminding from their own row are reminding themselves —
  // operationally meaningless. We still let the request through (no 4xx)
  // so the UI behaves consistently, but the where-clause narrows it to
  // their customer so nothing leaks across businesses.
  const overdueDebits = await prisma.creditTransaction.findMany({
    where: {
      type: 'DEBIT',
      status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
      due_date: { lt: today },
      ...orderB2BScopeWhere(req.admin),
    },
    include: {
      customer: { select: { customer_id: true, full_name: true, email: true, phone: true } },
    },
  });

  const byCustomer = new Map();
  for (const d of overdueDebits) {
    const owed = toNum(d.amount) - toNum(d.amount_paid);
    if (owed <= 0) continue;
    if (!byCustomer.has(d.customer_id)) {
      byCustomer.set(d.customer_id, {
        customer: d.customer,
        total: 0,
        invoices: 0,
        oldest: null,
      });
    }
    const row = byCustomer.get(d.customer_id);
    row.total += owed;
    row.invoices += 1;
    if (!row.oldest || new Date(d.due_date) < new Date(row.oldest)) row.oldest = d.due_date;
  }

  for (const row of byCustomer.values()) {
    const oldestDays = Math.floor((today - new Date(row.oldest)) / 86_400_000);
    fireNotify({
      template: 'credit.payment_overdue',
      to: { email: row.customer.email, phone: row.customer.phone, customer_id: row.customer.customer_id },
      data: {
        customer_name: row.customer.full_name,
        amount: `Rs. ${row.total.toFixed(2)}`,
        invoices: row.invoices,
        oldest_days: oldestDays,
      },
    });
  }

  res.json({
    data: {
      customers_notified: byCustomer.size,
      total_outstanding: [...byCustomer.values()].reduce((acc, r) => acc + r.total, 0),
    },
  });
}));

export default router;
