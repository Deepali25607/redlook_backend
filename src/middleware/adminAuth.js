// Admin authentication & authorization middleware (BRD §7.9 FR-ADM-07).
// Mirrors middleware/auth.js but on the AdminUser/AdminSession tables and
// requires the JWT to carry purpose: 'admin'. Customer tokens are deliberately
// rejected here so a logged-in customer can never call admin endpoints by
// reusing their bearer token.
//
// Authorization model: per-tile permissions. AdminUser.permissions is a
// text[] of tile keys from ADMIN_PERMISSIONS below; an endpoint declares
// which tile(s) it serves via requirePermission(...). The previous role-based
// model is gone — see migration 20260509200000_admin_permissions for how
// existing rows were backfilled.

import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { HttpError } from '../lib/http.js';

// Canonical permission catalog — the tiles a SuperAdmin can grant on the
// admin user form. Order here is the order shown in the form and on the
// dashboard. Any key referenced by requirePermission(...) MUST appear here,
// or the route is unreachable. The 'admin-users' tile is the privileged one
// that lets the holder create/disable other admins; treat it as you'd treat
// SuperAdmin in the old model.
export const ADMIN_PERMISSIONS = Object.freeze([
  'orders',
  'products',
  'categories',
  'coupons',
  'customers',
  'reviews',
  // The four report-family tiles each get their own permission so the
  // SuperAdmin can scope an admin to (say) Accounting without exposing
  // the rest. Migration 20260518100000_split_reports_permission auto-
  // grants the three new permissions to any AdminUser already holding
  // 'reports' so nobody loses access on deploy.
  'reports',
  'accounting',
  'customer-report',
  'b2b-customers',
  'settings',
  'admin-users',
]);

export async function requireAdmin(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Missing Authorization Bearer token');

    let payload;
    try { payload = verifyToken(token); }
    catch { throw new HttpError(401, 'Invalid or expired token'); }

    if (payload.purpose !== 'admin') throw new HttpError(401, 'Not an admin token');

    const session = await prisma.adminSession.findUnique({ where: { token } });
    if (!session) throw new HttpError(401, 'Admin session no longer active');
    if (session.expires_at < new Date()) {
      await prisma.adminSession.delete({ where: { token } });
      throw new HttpError(401, 'Admin session expired');
    }

    const admin = await prisma.adminUser.findUnique({ where: { admin_id: payload.sub } });
    if (!admin) throw new HttpError(401, 'Admin no longer exists');
    if (admin.status !== 'Active') throw new HttpError(403, 'Admin account not active');

    const { password_hash: _ph, ...safeAdmin } = admin;
    req.admin = safeAdmin;
    req.adminToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

// Composes with requireAdmin. Pass the tile permissions allowed for the
// endpoint. An admin passes if their permissions[] array intersects the
// caller's allowed list — having ANY one of the listed tiles is enough.
//   router.get('/orders', requireAdmin, requirePermission('orders'), handler)
//   router.put('/customers/:id/password', requireAdmin, requirePermission('admin-users'), handler)
export function requirePermission(...allowed) {
  return (req, _res, next) => {
    if (!req.admin) return next(new HttpError(401, 'Admin auth required'));
    const held = Array.isArray(req.admin.permissions) ? req.admin.permissions : [];
    if (!held.some((p) => allowed.includes(p))) {
      return next(new HttpError(403, `Requires permission: ${allowed.join(' or ')}`));
    }
    next();
  };
}

// Per-admin category whitelist for the Products + Categories tiles. Returns
// null when the admin is unrestricted (empty array or column missing),
// otherwise the array of allowed category_ids. Composes with requirePermission
// — scope only narrows access for admins who already hold the tile.
export function getAdminCategoryScope(admin) {
  if (!admin) return null;
  const scope = admin.category_scope;
  if (!Array.isArray(scope) || scope.length === 0) return null;
  return scope;
}

export function isCategoryInScope(admin, categoryId) {
  const scope = getAdminCategoryScope(admin);
  if (scope === null) return true;
  return scope.includes(categoryId);
}

// Spread into prisma `where` clauses: `where: { ...scopeWhere(req.admin), ... }`.
// Returns `{}` for unrestricted admins and `{ category_id: { in: scope } }`
// for scoped ones. Used by adminProducts list and exports.
export function scopeWhere(admin) {
  const scope = getAdminCategoryScope(admin);
  if (scope === null) return {};
  return { category_id: { in: scope } };
}

// Same idea but for the Category model itself, where the PK is `category_id`.
// Used by adminCategories list to hide out-of-scope rows entirely.
export function categoryScopeWhere(admin) {
  const scope = getAdminCategoryScope(admin);
  if (scope === null) return {};
  return { category_id: { in: scope } };
}

// Per-admin B2B scope. Returns the business_name string the admin is
// restricted to, or null when unrestricted (SuperAdmin / internal staff).
// The string should be spliced into list/report `where` clauses on
// every endpoint that exposes customer or order data — see helpers
// below for the common shapes.
export function getAdminB2BScope(admin) {
  if (!admin) return null;
  const name = admin.scoped_business_name;
  return name && String(name).trim() ? String(name).trim() : null;
}

// Spread into prisma `where` on the Customer model directly:
//   prisma.customer.findMany({ where: { ...customerB2BScopeWhere(req.admin), ... } })
// Returns `{}` when unrestricted and `{ business_name: <name>, customer_type: 'B2B' }`
// when scoped. The customer_type clause is redundant in theory (a B2C
// customer shouldn't have business_name set) but harmless and makes
// the filter self-documenting.
export function customerB2BScopeWhere(admin) {
  const name = getAdminB2BScope(admin);
  return name ? { business_name: name, customer_type: 'B2B' } : {};
}

// Spread into prisma `where` on models that store a `customer_id` FK
// (Order, CreditTransaction, PaymentReceived, Cart, Address,
// CustomerCreditConfig, …) — Prisma resolves the nested filter via
// the relation. The customer_type clause prevents an unlikely B2C
// record with a stray business_name from leaking through.
export function orderB2BScopeWhere(admin) {
  const name = getAdminB2BScope(admin);
  return name ? { customer: { business_name: name, customer_type: 'B2B' } } : {};
}

// Alias for clarity at the call site when the surrounding filter
// already nests inside a `customer:` block (e.g. OrderItem.order.customer.…).
// Identical to orderB2BScopeWhere in shape; named separately so a reader
// of the call site can tell which level of nesting is intended.
export function nestedCustomerB2BScopeWhere(admin) {
  return orderB2BScopeWhere(admin);
}
