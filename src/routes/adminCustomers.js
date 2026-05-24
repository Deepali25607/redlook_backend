// Admin customer management (BRD FR-ADM-02). Mounted at /api/admin/customers.
//
// Read access: all three roles (Support reps need to look up callers).
// Status change: Super + Operations.
// Password reset: Super only — high-risk action since it lets the admin
// take over a customer account; keep blast radius small.
//
// Personal-data editing (name, DOB, etc.) is intentionally NOT exposed.
// That belongs to the customer via their own profile flow; admins should
// not silently modify customer records. Account status is the right lever
// for support / abuse / GDPR-deletion workflows.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, notFound, badRequest } from '../lib/http.js';
import { requirePermission, customerB2BScopeWhere, getAdminB2BScope } from '../middleware/adminAuth.js';
import { serializeUser, serializeOrder, serializeAddress } from '../lib/serialize.js';
import {
  computeCreditState, applyPayment, serializeConfig, serializeTransaction,
  serializePayment, decorateOverdue,
} from '../lib/credit.js';
import { notify } from '../lib/notify.js';
import { sendXlsx, sendPdf } from '../lib/exports.js';
import { generatePaymentReceiptPDF } from '../lib/paymentReceipt.js';

const fireNotify = (args) => notify(args).catch((err) => console.error('[notify] failed:', err.message));
const fmtINR = (n) => `Rs. ${Number(n).toFixed(2)}`;

const router = Router();

// B2B-scoped admins must never reach a per-customer endpoint for a
// customer outside their business. Treated as 404 (rather than 403) so
// URLs don't leak the existence of out-of-scope customer rows. Applies
// to every /:id handler below — GET, PUT, POST, ledger, payments,
// credit — before the route-specific logic runs.
//
// Unscoped admins (the common case) skip the extra DB lookup entirely
// via the early return, so this only adds latency when scope is
// actually in play.
router.param('id', async (req, res, next, id) => {
  try {
    const scopedName = getAdminB2BScope(req.admin);
    if (!scopedName) return next();
    const c = await prisma.customer.findUnique({
      where: { customer_id: id },
      select: { business_name: true, customer_type: true },
    });
    if (!c || c.customer_type !== 'B2B' || c.business_name !== scopedName) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// BRD §8.1 lists Active/Inactive/Suspended/Deleted. We expose three —
// Inactive isn't currently produced by any flow so leaving it out keeps
// the admin UI from suggesting an action that doesn't have a counterpart.
const STATUS_VALUES = ['Active', 'Suspended', 'Deleted'];

const passwordRule = z.string()
  .min(8, 'Min 8 characters')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/\d/, 'Needs a number')
  .regex(/[^A-Za-z0-9]/, 'Needs a special character');

const statusSchema = z.object({ status: z.enum(STATUS_VALUES) });
const passwordSchema = z.object({ password: passwordRule });

const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

// ---------------------------------------------------------------
// GET /api/admin/customers — list/search/filter/paginate
// q matches name OR email OR phone (partial, case-insensitive)
// ---------------------------------------------------------------
router.get('/', requirePermission('customers'), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  // B2B-scoped admins see exactly one row — their linked customer. Any q/status
  // filter operates on top of the scope, so it can only ever produce that row
  // (or no row when filters don't match).
  const where = { ...customerB2BScopeWhere(req.admin) };
  if (req.query.status) where.account_status = String(req.query.status);
  if (req.query.q) {
    const q = String(req.query.q);
    where.OR = [
      { full_name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ];
  }

  const [total, rows, statusGroups] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    // Aggregates are filter-independent so the dashboard cards remain
    // meaningful while the table view narrows.
    prisma.customer.groupBy({
      by: ['account_status'],
      _count: { account_status: true },
    }),
  ]);

  const counts = { Active: 0, Suspended: 0, Inactive: 0, Deleted: 0 };
  for (const g of statusGroups) counts[g.account_status] = g._count.account_status;

  res.json({
    data: rows.map(serializeUser),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    summary: { ...counts, total: counts.Active + counts.Suspended + counts.Inactive + counts.Deleted },
  });
}));

// ---------------------------------------------------------------
// GET /api/admin/customers/:id — full detail with addresses, recent orders,
// and lifetime stats. Single round-trip to populate the drilldown drawer.
// ---------------------------------------------------------------
router.get('/:id', requirePermission('customers'), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { customer_id: req.params.id },
    include: { addresses: true },
  });
  if (!customer) notFound('Customer not found');

  const [orders, stats] = await Promise.all([
    prisma.order.findMany({
      where: { customer_id: req.params.id },
      include: { items: true },
      orderBy: { order_date: 'desc' },
      take: 10,
    }),
    // Lifetime totals exclude cancelled orders so "spend" reflects what was
    // actually delivered/charged, not abandoned attempts.
    prisma.order.aggregate({
      where: { customer_id: req.params.id, order_status: { not: 'Cancelled' } },
      _count: { _all: true },
      _sum: { total_amount: true },
      _avg: { total_amount: true },
    }),
  ]);

  res.json({
    data: {
      customer: serializeUser(customer),
      addresses: customer.addresses.map(serializeAddress),
      orders: orders.map(serializeOrder),
      stats: {
        total_orders: stats._count._all,
        lifetime_spend: Number(stats._sum.total_amount || 0),
        avg_order_value: Number(stats._avg.total_amount || 0),
      },
    },
  });
}));

// ---------------------------------------------------------------
// PUT /api/admin/customers/:id/status — Active / Suspended / Deleted
// Suspending or deleting revokes the customer's sessions immediately so
// they're kicked off the storefront on their next request.
// ---------------------------------------------------------------
router.put('/:id/status', requirePermission('customers'), validate(statusSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!target) notFound('Customer not found');

    const updated = await prisma.customer.update({
      where: { customer_id: req.params.id },
      data: { account_status: req.body.status },
    });

    if (req.body.status !== 'Active') {
      await prisma.session.deleteMany({ where: { customer_id: req.params.id } });
    }

    audit({
      customer_id: target.customer_id,
      action: 'admin.customer.status_change',
      meta: {
        from: target.account_status,
        to: req.body.status,
        by_admin_id: req.admin.admin_id,
        by_admin_email: req.admin.email,
      },
      ip: req.ip,
    });

    res.json({ data: serializeUser(updated) });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/customers/:id/password — emergency reset (Super only)
// Sessions revoked so the customer must log in with the new password.
// Use case: customer locked out, support engineer can't access their email.
// ---------------------------------------------------------------
// Customer password reset is gated to admins who can manage admin accounts
// (i.e. hold the 'admin-users' permission). Treating customer-password-reset
// as a privileged op preserves the prior "SuperAdmin only" intent.
router.put('/:id/password', requirePermission('admin-users'), validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!target) notFound('Customer not found');

    await prisma.customer.update({
      where: { customer_id: req.params.id },
      data: { password_hash: await bcrypt.hash(req.body.password, 10) },
    });
    await prisma.session.deleteMany({ where: { customer_id: req.params.id } });

    audit({
      customer_id: target.customer_id,
      action: 'admin.customer.password_reset',
      meta: { by_admin_id: req.admin.admin_id, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    res.json({ data: { ok: true } });
  }));

// ---------------------------------------------------------------
// PUT /api/admin/customers/:id/type — flip B2C ↔ B2B
// Drives credit-default tier and exposes business_name/gstin fields.
// ---------------------------------------------------------------
const typeSchema = z.object({
  customer_type: z.enum(['B2C', 'B2B']),
  business_name: z.string().max(150).nullable().optional(),
  gstin: z.string().max(15).nullable().optional(),
});
router.put('/:id/type', requirePermission('customers'), validate(typeSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!target) notFound('Customer not found');
    const updated = await prisma.customer.update({
      where: { customer_id: req.params.id },
      data: {
        customer_type: req.body.customer_type,
        business_name: req.body.business_name ?? null,
        gstin: req.body.gstin ?? null,
      },
    });
    audit({
      customer_id: target.customer_id,
      action: 'admin.customer.type_change',
      meta: { from: target.customer_type, to: req.body.customer_type, by_admin_email: req.admin.email },
      ip: req.ip,
    });
    res.json({ data: serializeUser(updated) });
  }));

// ---------------------------------------------------------------
// CREDIT — config / ledger / payments (BRD §2, §5, §7)
// ---------------------------------------------------------------

// GET /api/admin/customers/:id/credit
// One round-trip for the admin Credit tab: config + live state + the
// list of pending DEBITs so the drawer can render a "Pending payments"
// card without expanding the full ledger.
router.get('/:id/credit', requirePermission('customers'), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
  if (!customer) notFound('Customer not found');
  const [config, state, debits, recentPayments] = await Promise.all([
    prisma.customerCreditConfig.findUnique({ where: { customer_id: req.params.id } }),
    computeCreditState(req.params.id),
    prisma.creditTransaction.findMany({
      where: {
        customer_id: req.params.id,
        type: 'DEBIT',
        status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
      },
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }],
    }),
    prisma.paymentReceived.findMany({
      where: { customer_id: req.params.id },
      orderBy: { payment_date: 'desc' },
      take: 10,
    }),
  ]);
  res.json({
    data: {
      config: serializeConfig(config),
      state,
      customer_type: customer.customer_type,
      pending_invoices: decorateOverdue(debits.map(serializeTransaction)),
      recent_payments: recentPayments.map(serializePayment),
    },
  });
}));

// PUT /api/admin/customers/:id/credit — upsert config
const creditConfigSchema = z.object({
  credit_enabled: z.boolean(),
  credit_limit: z.number().min(0).max(10_000_000),
  payment_terms_days: z.number().int().min(0).max(365),
  terms_start_from: z.enum(['invoice', 'delivery']),
  status: z.enum(['active', 'blocked']),
  notes: z.string().max(1000).nullable().optional(),
});
router.put('/:id/credit', requirePermission('customers'), validate(creditConfigSchema),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!customer) notFound('Customer not found');

    const data = {
      credit_enabled: req.body.credit_enabled,
      credit_limit: req.body.credit_limit,
      payment_terms_days: req.body.payment_terms_days,
      terms_start_from: req.body.terms_start_from,
      status: req.body.status,
      notes: req.body.notes ?? null,
      updated_by: req.admin.email,
    };
    const before = await prisma.customerCreditConfig.findUnique({ where: { customer_id: req.params.id } });
    const config = await prisma.customerCreditConfig.upsert({
      where: { customer_id: req.params.id },
      update: data,
      create: { ...data, customer_id: req.params.id, created_by: req.admin.email },
    });

    audit({
      customer_id: req.params.id,
      action: 'admin.credit.config_update',
      meta: {
        before: before ? serializeConfig(before) : null,
        after: serializeConfig(config),
        by_admin_email: req.admin.email,
      },
      ip: req.ip,
    });

    const state = await computeCreditState(req.params.id);
    res.json({ data: { config: serializeConfig(config), state } });
  }));

// GET /api/admin/customers/:id/ledger — paginated transactions + payments
router.get('/:id/ledger', requirePermission('customers'), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
  if (!customer) notFound('Customer not found');

  const [transactions, payments, state] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: { customer_id: req.params.id },
      orderBy: { created_at: 'asc' },
    }),
    prisma.paymentReceived.findMany({
      where: { customer_id: req.params.id },
      orderBy: { payment_date: 'desc' },
    }),
    computeCreditState(req.params.id),
  ]);

  res.json({
    data: {
      transactions: decorateOverdue(transactions.map(serializeTransaction)),
      payments: payments.map(serializePayment),
      state,
    },
  });
}));

// POST /api/admin/customers/:id/payments — record a payment + FIFO allocate
const paymentSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  payment_date: z.string().or(z.date()),
  mode: z.enum(['BANK_TRANSFER', 'CHEQUE', 'UPI', 'CASH', 'CARD']),
  reference_no: z.string().max(100).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  // Optional manual allocation override — array of CreditTransaction IDs
  // in priority order. Omit for default FIFO behaviour.
  target_invoice_ids: z.array(z.string()).optional(),
});
router.post('/:id/payments', requirePermission('customers'), validate(paymentSchema),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!customer) notFound('Customer not found');

    const result = await prisma.$transaction(async (tx) => {
      return applyPayment(tx, {
        customerId: req.params.id,
        amount: req.body.amount,
        paymentDate: req.body.payment_date,
        mode: req.body.mode,
        referenceNo: req.body.reference_no ?? null,
        targetIds: req.body.target_invoice_ids ?? null,
        createdBy: req.admin.email,
        notes: req.body.notes ?? null,
      });
    });

    audit({
      customer_id: req.params.id,
      action: 'admin.credit.payment_recorded',
      meta: {
        amount: req.body.amount,
        mode: req.body.mode,
        reference_no: req.body.reference_no,
        allocations: result.allocations,
        unallocated: result.unallocated,
        by_admin_email: req.admin.email,
      },
      ip: req.ip,
    });

    // Receipt notification — BRD §7 "Generate a payment receipt and send
    // to customer". For now this is a templated email/SMS; a PDF receipt
    // can be wired in later by mirroring the invoice generator.
    fireNotify({
      template: 'credit.payment_received',
      to: { email: customer.email, phone: customer.phone, customer_id: customer.customer_id },
      data: {
        customer_name: customer.full_name,
        amount: fmtINR(req.body.amount),
        payment_date: new Date(req.body.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        mode: req.body.mode.replace('_', ' ').toLowerCase(),
        reference_no: req.body.reference_no,
        allocations: result.allocations.length,
      },
    });

    const state = await computeCreditState(req.params.id);
    res.status(201).json({
      data: {
        payment: serializePayment(result.payment),
        allocations: result.allocations,
        unallocated: result.unallocated,
        state,
      },
    });
  }));

// GET /api/admin/customers/:id/payments/:paymentId/receipt
// Admin-side mirror of the customer receipt download. Same PDF, gated
// on the 'customers' permission rather than self-ownership so support
// reps can re-send a receipt that the customer lost.
router.get('/:id/payments/:paymentId/receipt', requirePermission('customers'),
  asyncHandler(async (req, res) => {
    const payment = await prisma.paymentReceived.findUnique({
      where: { id: req.params.paymentId },
    });
    if (!payment || payment.customer_id !== req.params.id) {
      notFound('Receipt not found');
    }
    const [customer, settings] = await Promise.all([
      prisma.customer.findUnique({ where: { customer_id: req.params.id } }),
      prisma.businessSettings.findUnique({ where: { id: 1 } }),
    ]);
    if (!customer) notFound('Customer not found');

    const allocs = Array.isArray(payment.applied_to_invoice_ids) ? payment.applied_to_invoice_ids : [];
    const txIds = allocs.map((a) => a?.credit_transaction_id).filter(Boolean);
    const txs = txIds.length
      ? await prisma.creditTransaction.findMany({ where: { id: { in: txIds } } })
      : [];
    const allocations = allocs.map((a) => ({
      applied_amount: Number(a?.applied_amount || 0),
      credit_transaction: txs.find((t) => t.id === a?.credit_transaction_id) || null,
    }));

    const pdf = await generatePaymentReceiptPDF({ payment, customer, allocations, settings });
    const filename = `receipt_${payment.id.slice(0, 8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  }));

// GET /api/admin/customers/:id/ledger/export?format=xlsx|pdf
// CSV/PDF export of the same data the Ledger tab shows. Reuses the
// shared exports lib so currency/date formatting matches every other
// admin export. BRD §5 — "Export to CSV/PDF".
router.get('/:id/ledger/export', requirePermission('customers'), asyncHandler(async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
  if (!customer) notFound('Customer not found');

  const transactions = await prisma.creditTransaction.findMany({
    where: { customer_id: req.params.id },
    orderBy: { created_at: 'asc' },
  });
  const decorated = decorateOverdue(transactions.map(serializeTransaction));

  const format = String(req.query.format || 'xlsx').toLowerCase();
  const columns = [
    { key: 'created_at', header: 'Date', format: 'datetime', width: 18 },
    { key: 'type', header: 'Type', width: 12 },
    { key: 'order_id', header: 'Order ID', width: 20 },
    { key: 'amount', header: 'Amount', format: 'currency', width: 14 },
    { key: 'amount_paid', header: 'Paid', format: 'currency', width: 14 },
    { key: 'running_balance', header: 'Running balance', format: 'currency', width: 18 },
    { key: 'due_date', header: 'Due date', format: 'date', width: 14 },
    { key: 'status', header: 'Status', width: 16 },
    { key: 'notes', header: 'Notes', width: 40 },
  ];

  const safeName = String(customer.full_name || 'customer').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30);
  const baseFilename = `ledger_${safeName}_${customer.customer_id.slice(0, 8)}`;
  const state = await computeCreditState(req.params.id);
  const summary = [
    { label: 'Customer', value: `${customer.full_name} (${customer.email})` },
    { label: 'Type', value: customer.customer_type },
    { label: 'Outstanding', value: state.outstanding },
    { label: 'Available credit', value: state.available },
    { label: 'Overdue amount', value: state.overdueAmount },
    { label: 'Generated', value: new Date().toISOString() },
  ];

  if (format === 'pdf') {
    return sendPdf(res, {
      columns, rows: decorated,
      filename: `${baseFilename}.pdf`,
      title: `Customer Ledger — ${customer.full_name}`,
      subtitle: `${customer.customer_type} · Outstanding Rs. ${state.outstanding.toFixed(2)}`,
      summary,
    });
  }
  return sendXlsx(res, {
    sheetName: 'Ledger',
    columns, rows: decorated,
    filename: `${baseFilename}.xlsx`,
    title: `Customer Ledger — ${customer.full_name}`,
    summary,
  });
}));

// POST /api/admin/customers/:id/credit/adjustments — manual ADJUSTMENT row
// (write-off, return-credit, opening-balance correction). Negative amounts
// reduce outstanding (acts like a credit); positives raise it. Audited.
const adjustmentSchema = z.object({
  amount: z.number().min(-10_000_000).max(10_000_000),
  reason: z.string().min(1).max(500),
});
router.post('/:id/credit/adjustments', requirePermission('customers'),
  validate(adjustmentSchema), asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { customer_id: req.params.id } });
    if (!customer) notFound('Customer not found');
    if (req.body.amount === 0) badRequest('Amount cannot be zero');

    const created = await prisma.$transaction(async (tx) => {
      const previous = await tx.creditTransaction.findFirst({
        where: { customer_id: req.params.id },
        orderBy: { created_at: 'desc' },
        select: { running_balance: true },
      });
      const prevBalance = Number(previous?.running_balance || 0);
      return tx.creditTransaction.create({
        data: {
          customer_id: req.params.id,
          type: 'ADJUSTMENT',
          amount: Math.abs(req.body.amount),
          // ADJUSTMENT moves running_balance by the signed amount; the
          // type marker plus the sign tells the ledger reader the
          // direction.
          running_balance: prevBalance + req.body.amount,
          status: 'PAID',
          notes: req.body.reason,
          created_by: req.admin.email,
        },
      });
    });

    audit({
      customer_id: req.params.id,
      action: 'admin.credit.adjustment',
      meta: { amount: req.body.amount, reason: req.body.reason, by_admin_email: req.admin.email },
      ip: req.ip,
    });

    const state = await computeCreditState(req.params.id);
    res.status(201).json({ data: { transaction: serializeTransaction(created), state } });
  }));

export default router;
