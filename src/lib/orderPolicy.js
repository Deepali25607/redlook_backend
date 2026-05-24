// Shared cancellation-policy helpers.
//
// Cancellation cutoff is admin-configurable via BusinessSettings.cancellation_cutoff_status:
// the cutoff is the FIRST status at which a cancel is REJECTED. Anything
// strictly before the cutoff in the lifecycle ordering can still be cancelled.
//
// The customer-facing /api/orders/:id/cancel route and the admin-facing
// PUT /api/admin/orders/:id/status route (when target='Cancelled') both
// consult this so a single config controls both surfaces.

import { prisma } from './prisma.js';

// Forward order of the lifecycle. Index lookups give us "before-X" semantics.
// Cancelled / ReturnRequested are terminal and not part of this ordering —
// they short-circuit before this helper is called.
const ORDER_LIFECYCLE = ['Placed', 'Confirmed', 'Packed', 'Out for Delivery', 'Delivered'];

// Default matches the policy that shipped before the admin-configurable
// cutoff existed: cancel allowed up to (but not including) Out for Delivery.
const DEFAULT_CUTOFF = 'Out for Delivery';

// Returns true when an order in `currentStatus` is allowed to transition to
// 'Cancelled' under the supplied `cutoffStatus`. Both arguments must be
// values from ORDER_LIFECYCLE — terminal states should be checked by the
// caller before this helper.
export function canCancelOrder(currentStatus, cutoffStatus) {
  const cutoff = ORDER_LIFECYCLE.indexOf(cutoffStatus || DEFAULT_CUTOFF);
  const current = ORDER_LIFECYCLE.indexOf(currentStatus);
  if (cutoff < 0 || current < 0) return false;
  return current < cutoff;
}

// Reads the current cutoff straight from BusinessSettings. Cached briefly
// in-process to avoid a DB hit on every cancel call; the cutoff doesn't
// change in real-time and a few seconds of staleness is fine.
let cachedCutoff = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

export async function getCancellationCutoff() {
  if (cachedCutoff && Date.now() - cachedAt < CACHE_TTL_MS) return cachedCutoff;
  const settings = await prisma.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
    select: { cancellation_cutoff_status: true },
  });
  cachedCutoff = settings.cancellation_cutoff_status || DEFAULT_CUTOFF;
  cachedAt = Date.now();
  return cachedCutoff;
}

// Invalidate the cache when the admin saves a new cutoff. Called from the
// admin settings update handler.
export function invalidateCutoffCache() {
  cachedCutoff = null;
  cachedAt = 0;
}

// Customer-facing message for "you can't cancel anymore". Embedded in the
// 400 response so the storefront can render the policy verbatim without
// duplicating the logic.
export function cancellationBlockedMessage(currentStatus, cutoffStatus) {
  const cutoff = cutoffStatus || DEFAULT_CUTOFF;
  return `Order can no longer be cancelled. Cancellation is closed once the order reaches "${cutoff}" status (current: "${currentStatus}").`;
}
