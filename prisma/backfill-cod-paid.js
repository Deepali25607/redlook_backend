// One-shot backfill — flips payment_status Pending -> Paid on every COD order
// that is already Delivered. Required because adminOrders.js v1 only updated
// order_status; payment was treated as a separate concern. v2 (2026-05-09)
// auto-flips inside the transaction, but historical rows need a sweep.
//
// Idempotent — running it again finds nothing to update. Safe to leave in the
// repo and re-run any time a deploy worries about consistency.
//
// Run: node prisma/backfill-cod-paid.js

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const stale = await prisma.order.findMany({
    where: { payment_method: 'COD', order_status: 'Delivered', payment_status: 'Pending' },
    select: { order_id: true, customer_id: true, total_amount: true, timeline: true },
  });

  if (stale.length === 0) {
    console.log('[backfill] no rows to update — payment_status already consistent.');
    return;
  }

  console.log(`[backfill] flipping ${stale.length} COD/Delivered order(s) Pending -> Paid.`);
  for (const o of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { order_id: o.order_id },
        data: {
          payment_status: 'Paid',
          // Append a backfill marker so the activity feed shows when this happened.
          timeline: [
            ...(o.timeline || []),
            {
              status: 'Delivered',
              at: new Date().toISOString(),
              note: 'Payment marked Paid (backfill: COD on delivery).',
              backfill: true,
            },
          ],
        },
      });
      await tx.auditLog.create({
        data: {
          customer_id: o.customer_id,
          action: 'admin.order.payment_backfill',
          meta: {
            order_id: o.order_id,
            payment_status_flip: 'Pending->Paid (COD on delivery)',
            source: 'backfill-cod-paid.js',
          },
          ip: null,
        },
      });
    });
    console.log(`  · ${o.order_id} — ₹${Number(o.total_amount).toFixed(2)}`);
  }
  console.log('[backfill] done.');
}

main()
  .catch((err) => { console.error('[backfill] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
