// Credit / Pay-Later engine. The route layer composes these primitives so
// the same rules apply whether credit is consumed at customer checkout or
// at admin delivery-confirmation.
//
// Glossary (matches BRD §9):
//   DEBIT       = order placed on credit; raises outstanding
//   CREDIT      = payment received against an invoice; lowers outstanding
//   ADJUSTMENT  = manual write-off / discount / return; signed amount
//
// "outstanding" = sum of (DEBIT.amount - DEBIT.amount_paid) for non-PAID
// rows. Equivalent to running_balance of the most recent transaction
// minus any post-balance ADJUSTMENTs — but we recompute from the source
// rows so a future correction can't drift the cached running_balance.

import { prisma } from './prisma.js';
import { HttpError } from './http.js';

const toNum = (d) => (d == null ? 0 : Number(d));

// Sum of all DEBIT amounts that are not fully paid. Source of truth for
// the customer's "outstanding" figure shown in their profile and used as
// the gate against credit_limit.
async function outstandingFor(customerId, tx = prisma) {
  const debits = await tx.creditTransaction.findMany({
    where: {
      customer_id: customerId,
      type: 'DEBIT',
      status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
    },
    select: { amount: true, amount_paid: true },
  });
  return debits.reduce((acc, t) => acc + (toNum(t.amount) - toNum(t.amount_paid)), 0);
}

// Whole credit-state snapshot for a customer. Used by both the admin
// credit-config view and the customer pending-invoices view, plus the
// gates in checkout/delivery-confirmation.
export async function computeCreditState(customerId, tx = prisma) {
  const [config, settings, outstanding] = await Promise.all([
    tx.customerCreditConfig.findUnique({ where: { customer_id: customerId } }),
    tx.businessSettings.findUnique({ where: { id: 1 } }),
    outstandingFor(customerId, tx),
  ]);

  const limit = toNum(config?.credit_limit);
  const available = Math.max(0, limit - outstanding);
  const overdueBlockDays = settings?.credit_overdue_block_days ?? 15;

  // Walk DEBITs once to compute "oldest overdue days" and how many
  // invoices are past due. The block-on-overdue gate compares the worst
  // offender against overdueBlockDays.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const debits = await tx.creditTransaction.findMany({
    where: {
      customer_id: customerId,
      type: 'DEBIT',
      status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
    },
    select: { id: true, due_date: true, amount: true, amount_paid: true },
  });
  let oldestOverdueDays = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  for (const d of debits) {
    if (!d.due_date) continue;
    const dd = new Date(d.due_date);
    dd.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today - dd) / 86_400_000);
    if (diffDays > 0) {
      overdueCount += 1;
      overdueAmount += toNum(d.amount) - toNum(d.amount_paid);
      if (diffDays > oldestOverdueDays) oldestOverdueDays = diffDays;
    }
  }

  return {
    enabled: !!config?.credit_enabled,
    status: config?.status || 'inactive', // 'active' | 'blocked' | 'inactive' (no row)
    limit,
    outstanding,
    available,
    overdueCount,
    overdueAmount,
    oldestOverdueDays,
    overdueBlockDays,
    paymentTermsDays: config?.payment_terms_days ?? 30,
    termsStartFrom: config?.terms_start_from || 'delivery',
  };
}

// Decide whether this customer can place a *new* credit order for
// `orderAmount`. Returns null if eligible, otherwise an HttpError-ready
// reason. Callers throw the error themselves so the response code stays
// consistent with the surrounding route.
export async function checkEligibility(customerId, orderAmount, tx = prisma) {
  const state = await computeCreditState(customerId, tx);

  if (!state.enabled) {
    return { code: 'CREDIT_NOT_ENABLED', message: 'Credit is not enabled for this account.' };
  }
  if (state.status === 'blocked') {
    return { code: 'CREDIT_BLOCKED', message: 'Credit is temporarily blocked. Please contact us.' };
  }
  if (state.overdueBlockDays > 0 && state.oldestOverdueDays > state.overdueBlockDays) {
    return {
      code: 'CREDIT_OVERDUE_BLOCK',
      message: `You have an invoice overdue by ${state.oldestOverdueDays} days. Please clear it before placing a new credit order.`,
      oldest_overdue_days: state.oldestOverdueDays,
    };
  }
  const projected = state.outstanding + Number(orderAmount || 0);
  if (projected > state.limit) {
    return {
      code: 'CREDIT_LIMIT_EXCEEDED',
      message: `Credit limit exceeded. Outstanding: ₹${state.outstanding.toFixed(2)}. Limit: ₹${state.limit.toFixed(2)}.`,
      outstanding: state.outstanding,
      limit: state.limit,
    };
  }
  return null;
}

// Compute due_date from a config + a base date (order date or delivery
// date depending on terms_start_from).
export function computeDueDate(termsStartFrom, paymentTermsDays, orderDate, deliveryDate) {
  const base = termsStartFrom === 'invoice' ? orderDate : (deliveryDate || orderDate);
  const due = new Date(base);
  due.setDate(due.getDate() + Number(paymentTermsDays || 0));
  return due;
}

// Append a DEBIT row representing "order placed/delivered on credit".
// running_balance is materialised so the ledger view doesn't have to
// re-sum from epoch on each read. Caller passes the open prisma tx so
// this composes inside order placement / delivery confirmation
// transactions cleanly.
export async function recordCreditDebit(tx, {
  customerId, orderId, amount, dueDate, createdBy = null, notes = null,
}) {
  const previous = await tx.creditTransaction.findFirst({
    where: { customer_id: customerId },
    orderBy: { created_at: 'desc' },
    select: { running_balance: true },
  });
  const prevBalance = toNum(previous?.running_balance);
  const newBalance = prevBalance + Number(amount);
  return tx.creditTransaction.create({
    data: {
      customer_id: customerId,
      order_id: orderId,
      type: 'DEBIT',
      amount,
      amount_paid: 0,
      running_balance: newBalance,
      due_date: dueDate,
      status: 'PENDING',
      notes,
      created_by: createdBy,
    },
  });
}

// Apply a payment to outstanding DEBITs. FIFO by default (oldest due
// first); if `targetIds` is provided, allocate against those in order
// instead. Mutates the DEBIT rows' amount_paid + status, appends a
// CREDIT row for the running_balance trail, and creates the
// PaymentReceived envelope. Returns { payment, allocations }.
export async function applyPayment(tx, {
  customerId, amount, paymentDate, mode, referenceNo = null,
  targetIds = null, createdBy = null, notes = null,
}) {
  const where = {
    customer_id: customerId,
    type: 'DEBIT',
    status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
  };
  if (targetIds?.length) where.id = { in: targetIds };

  // FIFO over due_date (nulls last) then created_at — matches the BRD's
  // "oldest outstanding invoice first" rule.
  const orderBy = targetIds?.length
    ? [{ created_at: 'asc' }]
    : [{ due_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }];
  const debits = await tx.creditTransaction.findMany({ where, orderBy });

  // If the admin specified targetIds, preserve their order rather than the
  // SQL ordering — they may have a reason for picking a specific invoice.
  const ordered = targetIds?.length
    ? targetIds.map((id) => debits.find((d) => d.id === id)).filter(Boolean)
    : debits;

  let remaining = Number(amount);
  const allocations = [];
  for (const d of ordered) {
    if (remaining <= 0) break;
    const owed = toNum(d.amount) - toNum(d.amount_paid);
    if (owed <= 0) continue;
    const apply = Math.min(remaining, owed);
    const newPaid = toNum(d.amount_paid) + apply;
    const fullyPaid = Math.abs(newPaid - toNum(d.amount)) < 0.005;
    await tx.creditTransaction.update({
      where: { id: d.id },
      data: {
        amount_paid: newPaid,
        status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
      },
    });
    allocations.push({ credit_transaction_id: d.id, applied_amount: Number(apply.toFixed(2)) });
    remaining -= apply;
  }

  // Append a single CREDIT row capturing the payment in the running
  // balance — keeps the ledger readable as one chronological feed.
  const previous = await tx.creditTransaction.findFirst({
    where: { customer_id: customerId },
    orderBy: { created_at: 'desc' },
    select: { running_balance: true },
  });
  const newBalance = toNum(previous?.running_balance) - Number(amount);
  await tx.creditTransaction.create({
    data: {
      customer_id: customerId,
      type: 'CREDIT',
      amount: Number(amount),
      amount_paid: Number(amount),
      running_balance: newBalance,
      status: 'PAID',
      notes: notes || `Payment via ${mode}${referenceNo ? ` · Ref ${referenceNo}` : ''}`,
      created_by: createdBy,
    },
  });

  const payment = await tx.paymentReceived.create({
    data: {
      customer_id: customerId,
      amount: Number(amount),
      payment_date: new Date(paymentDate),
      mode,
      reference_no: referenceNo,
      applied_to_invoice_ids: allocations,
      notes,
      created_by: createdBy,
    },
  });

  return { payment, allocations, unallocated: Number(remaining.toFixed(2)) };
}

// Convenience: turn a config row + state into the JSON shape both the
// customer profile and the admin drawer consume.
export function serializeConfig(config) {
  if (!config) {
    return {
      credit_enabled: false,
      credit_limit: 0,
      payment_terms_days: 30,
      terms_start_from: 'delivery',
      status: 'inactive',
      notes: null,
      updated_by: null,
      updated_at: null,
    };
  }
  return {
    credit_enabled: config.credit_enabled,
    credit_limit: toNum(config.credit_limit),
    payment_terms_days: config.payment_terms_days,
    terms_start_from: config.terms_start_from,
    status: config.status,
    notes: config.notes,
    updated_by: config.updated_by,
    updated_at: config.updated_at,
  };
}

export function serializeTransaction(t) {
  return {
    id: t.id,
    order_id: t.order_id,
    type: t.type,
    amount: toNum(t.amount),
    amount_paid: toNum(t.amount_paid),
    running_balance: toNum(t.running_balance),
    due_date: t.due_date,
    status: t.status,
    notes: t.notes,
    created_at: t.created_at,
    created_by: t.created_by,
  };
}

export function serializePayment(p) {
  return {
    id: p.id,
    amount: toNum(p.amount),
    payment_date: p.payment_date,
    mode: p.mode,
    reference_no: p.reference_no,
    applied_to_invoice_ids: p.applied_to_invoice_ids || [],
    notes: p.notes,
    created_at: p.created_at,
    created_by: p.created_by,
  };
}

// Decorate transactions with computed `is_overdue` + `days_overdue` so
// the UI doesn't reinvent the math. Pure — no DB hit.
export function decorateOverdue(transactions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return transactions.map((t) => {
    if (t.type !== 'DEBIT' || t.status === 'PAID' || !t.due_date) {
      return { ...t, is_overdue: false, days_overdue: 0 };
    }
    const dd = new Date(t.due_date);
    dd.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - dd) / 86_400_000);
    return { ...t, is_overdue: diff > 0, days_overdue: Math.max(0, diff) };
  });
}

// Throw helper — converts a checkEligibility result into an HttpError.
export function throwIfIneligible(result) {
  if (!result) return;
  throw new HttpError(400, result.message, { code: result.code, ...result });
}
