// Daily credit maintenance pass (BRD §8 + §10).
//
// Runs in-process via setInterval. For a single-instance deployment this
// is fine; if the API ever scales horizontally, gate the run on a Redis
// lock or move to a dedicated cron worker so two replicas don't both
// dispatch reminders.
//
// On each tick:
//   1. Mark unpaid DEBITs whose due_date < today as OVERDUE.
//   2. Walk unpaid DEBITs and dispatch reminder notifications based on
//      days-until-due / days-overdue (matching the BRD cadence).
//   3. Dedupe via the Notification table — never send the same template
//      to the same customer for the same invoice twice in 20 hours.
//
// All dispatches are fire-and-forget; failures land in the Notification
// table with status='failed' and don't block the rest of the run.

import { prisma } from './prisma.js';
import { notify } from './notify.js';

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24h once started
// Slight under-run on the dedupe window so a daily run doesn't
// accidentally suppress itself on its own second run if the server was
// restarted between ticks.
const DEDUPE_WINDOW_MS = 20 * 60 * 60 * 1000;
const fmtINR = (n) => `Rs. ${Number(n).toFixed(2)}`;
const toNum = (d) => (d == null ? 0 : Number(d));

let timer = null;

// "Was template X already dispatched to customer Y about invoice Z (or
// without an invoice context for bulk-style reminders) in the last 20
// hours?" Single Notification.findFirst, indexed on customer_id.
async function recentlySent(customerId, template, invoiceId) {
  const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const where = {
    customer_id: customerId,
    template,
    created_at: { gte: cutoff },
  };
  if (invoiceId) {
    // Body / subject contain the invoice id — cheap substring check
    // beats adding another column. False-positives on a different
    // invoice with the same id prefix are a non-issue (invoice ids are
    // UUIDs, full-length).
    where.OR = [
      { body: { contains: invoiceId } },
      { subject: { contains: invoiceId } },
    ];
  }
  const hit = await prisma.notification.findFirst({ where, select: { notification_id: true } });
  return !!hit;
}

function daysBetween(a, b) {
  const da = new Date(a); da.setHours(0, 0, 0, 0);
  const db = new Date(b); db.setHours(0, 0, 0, 0);
  return Math.round((db - da) / 86_400_000);
}

// Pretty short-id for the SMS body, since the full UUID is too long for
// a 160-char SMS. Keep enough chars that it's still a unique reference.
function shortInvoiceLabel(transaction) {
  if (transaction.order_id) return `Order ${transaction.order_id}`;
  return `Invoice #${transaction.id.slice(0, 8)}`;
}

export async function runCreditMaintenance({ logger = console } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Step 1 — mark OVERDUE
  const flipped = await prisma.creditTransaction.updateMany({
    where: {
      type: 'DEBIT',
      status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      due_date: { lt: today },
    },
    data: { status: 'OVERDUE' },
  });
  logger.log(`[credit-scheduler] marked ${flipped.count} debit row(s) OVERDUE`);

  // Step 2 — reminders. Pull all unpaid DEBITs with their customer in
  // one round-trip; small enough to keep in memory for normal volumes.
  const debits = await prisma.creditTransaction.findMany({
    where: {
      type: 'DEBIT',
      status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
      due_date: { not: null },
    },
    include: {
      customer: {
        select: { customer_id: true, full_name: true, email: true, phone: true },
      },
    },
  });

  let sent = 0;
  for (const d of debits) {
    const owed = toNum(d.amount) - toNum(d.amount_paid);
    if (owed <= 0) continue;

    const daysUntilDue = daysBetween(today, d.due_date);
    const daysOverdue = -daysUntilDue;

    let template = null;
    let extraData = {};
    if (daysUntilDue === 5) {
      template = 'credit.payment_reminder';
      extraData = { days_remaining: 5 };
    } else if (daysUntilDue === 0) {
      template = 'credit.payment_due';
    } else if (daysOverdue === 1) {
      template = 'credit.payment_overdue';
    } else if (daysOverdue > 1 && daysOverdue % 7 === 0) {
      // Escalation cadence — every 7 days while still overdue.
      template = 'credit.payment_overdue';
    }
    if (!template) continue;

    // Dedupe: have we already sent this exact template to this customer
    // about this exact invoice in the last 20 hours? If so, skip.
    if (await recentlySent(d.customer_id, template, d.id)) continue;

    const data = {
      customer_name: d.customer.full_name,
      amount: fmtINR(owed),
      invoice_label: shortInvoiceLabel(d),
      due_date: new Date(d.due_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      }),
      oldest_days: daysOverdue > 0 ? daysOverdue : 0,
      ...extraData,
    };

    try {
      await notify({
        template,
        to: { email: d.customer.email, phone: d.customer.phone, customer_id: d.customer_id },
        data,
      });
      sent += 1;
    } catch (err) {
      logger.error(`[credit-scheduler] notify failed for ${d.id}: ${err.message}`);
    }
  }

  logger.log(`[credit-scheduler] dispatched ${sent} reminder(s) across ${debits.length} unpaid invoice(s)`);
  return { flipped: flipped.count, sent, scanned: debits.length };
}

export function startCreditScheduler({ logger = console } = {}) {
  if (timer) return;
  // Kick off immediately so a fresh boot catches anything that's gone
  // overdue while the server was off; subsequent runs go on the 24-hour
  // cadence. Errors are logged but never bubble — the API stays up.
  runCreditMaintenance({ logger }).catch((err) => {
    logger.error(`[credit-scheduler] initial run failed: ${err.message}`);
  });
  timer = setInterval(() => {
    runCreditMaintenance({ logger }).catch((err) => {
      logger.error(`[credit-scheduler] tick failed: ${err.message}`);
    });
  }, RUN_INTERVAL_MS);
  // Don't keep the Node event loop alive just for this timer — graceful
  // shutdowns (SIGTERM, test runs) shouldn't have to clearInterval.
  if (timer.unref) timer.unref();
  logger.log(`[credit-scheduler] started (every ${RUN_INTERVAL_MS / 3_600_000}h)`);
}

export function stopCreditScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
