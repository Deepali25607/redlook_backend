// Admin user management (slice 2.5 of Phase 4). Mounted at /api/admin/users.
// requireAdmin runs at the parent (admin.js); the entire router is gated on
// the 'admin-users' permission — that's how SuperAdmin's authority transfers
// in the new per-tile model.
//
// Self-protection rules:
//   - Cannot change your own permissions or status (prevents self-lockout)
//   - Cannot remove the 'admin-users' permission from the only admin who
//     holds it, or disable that admin — without it nobody can manage admin
//     accounts
//   - Disabling or password-resetting an admin invalidates their sessions
//   - Soft-delete: DELETE flips status to 'Disabled', does not drop the row
//     (preserves audit history and FK integrity for sessions, etc.)

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../lib/http.js';
import { requirePermission, ADMIN_PERMISSIONS } from '../middleware/adminAuth.js';

const router = Router();

// Same complexity rule used for customer registration (FR-AUTH-03).
const passwordRule = z.string()
  .min(8, 'Min 8 characters')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/\d/, 'Needs a number')
  .regex(/[^A-Za-z0-9]/, 'Needs a special character');

const STATUS_VALUES = ['Active', 'Disabled'];

// Permissions is a set: order is irrelevant, duplicates are meaningless. We
// dedupe + sort on the way in so audit diffs / "did this change?" checks
// can compare arrays positionally. Min-1 because an admin with zero
// permissions can authenticate but see nothing — better to reject at the
// boundary than ship a confused account.
const permissionsField = z.array(z.enum(ADMIN_PERMISSIONS))
  .min(1, 'Pick at least one tile')
  .max(ADMIN_PERMISSIONS.length, 'Too many tiles')
  .transform((arr) => Array.from(new Set(arr)).sort());

// Empty array = unrestricted (full access). Populated = whitelist of
// category_ids the admin can manage. Existence of each id is validated
// against the Category table in the handler (a stale id would silently
// lock the admin out).
const categoryScopeField = z.array(z.string().min(1).max(50))
  .max(100)
  .transform((arr) => Array.from(new Set(arr)).sort());

// B2B scope — business_name string. Null / empty clears the scope
// (admin reverts to full-view). Handler validates that at least one
// active B2B customer carries this business_name before persisting,
// so the SuperAdmin can't fat-finger a name that doesn't exist yet.
const scopedBusinessField = z.string().trim().max(150).nullable().optional();

const createSchema = z.object({
  full_name: z.string().min(2).max(100),
  email: z.string().email().max(150),
  password: passwordRule,
  permissions: permissionsField,
  category_scope: categoryScopeField.default([]),
  scoped_business_name: scopedBusinessField,
});

const updateSchema = z.object({
  full_name: z.string().min(2).max(100).optional(),
  permissions: permissionsField.optional(),
  category_scope: categoryScopeField.optional(),
  status: z.enum(STATUS_VALUES).optional(),
  scoped_business_name: scopedBusinessField,
}).refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

const resetPasswordSchema = z.object({ password: passwordRule });

// Strip password hash; scoped_business_name is already a plain column on
// AdminUser so no joining or flattening is needed.
const safe = (a) => { const { password_hash: _ph, ...rest } = a; return rest; };

// Set-equality on string arrays. Inputs are pre-sorted by permissionsField;
// stored rows are pre-sorted by every code path that writes them.
const samePermissions = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => v === b[i]);

// Best-effort audit helper — never blocks the response.
const audit = (data) => prisma.auditLog.create({ data })
  .catch((err) => console.error('[audit] failed:', err.message));

// Counts active admins who hold the 'admin-users' permission. If the count
// drops to zero, no one can create/edit/disable admins anymore — that's the
// "lock yourselves out" scenario the guards below prevent.
const countActiveAdminUsersHolders = () => prisma.adminUser.count({
  where: { permissions: { has: 'admin-users' }, status: 'Active' },
});

// Reject any category_scope entry that doesn't match a real Category row.
// Empty array = unrestricted; skip the lookup.
async function assertCategoriesExist(ids) {
  if (!ids || ids.length === 0) return;
  const found = await prisma.category.findMany({
    where: { category_id: { in: ids } },
    select: { category_id: true },
  });
  const knownIds = new Set(found.map((c) => c.category_id));
  const missing = ids.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    badRequest(`Unknown categor${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`);
  }
}

// Reject a scoped_business_name that doesn't match any active B2B
// customer. Stops the SuperAdmin from fat-fingering a business name
// that doesn't exist yet — without this, the new admin would log in
// and just see an empty portal forever. Empty / null = clear the scope.
async function assertBusinessNameExists(name) {
  if (name == null || !String(name).trim()) return;
  const trimmed = String(name).trim();
  const c = await prisma.customer.findFirst({
    where: {
      business_name: trimmed,
      customer_type: 'B2B',
      account_status: 'Active',
    },
    select: { customer_id: true },
  });
  if (!c) badRequest(`No active B2B customer found with business name "${trimmed}"`);
}

// Entire router is gated to admins who can manage admin accounts.
router.use(requirePermission('admin-users'));

// ---------------------------------------------------------------
// GET /api/admin/users/b2b-options — distinct (business_name, gstin)
// pairs across active B2B customers, for the "B2B scope" dropdown in
// the Add/Edit Admin modal. Deduplicated because one business can have
// many contact rows (different login users under the same company),
// and the SuperAdmin shouldn't have to disambiguate those at scope-
// assignment time.
//
// Lives under /users (not /customers) so the SuperAdmin who's editing
// admin accounts doesn't need a separate 'customers' permission just
// to see the dropdown.
// ---------------------------------------------------------------
router.get('/b2b-options', asyncHandler(async (_req, res) => {
  // groupBy on (business_name, gstin) collapses many-contacts-per-business
  // into one row each. Customers with no business_name are filtered out —
  // they can't be the target of a B2B scope anyway.
  const groups = await prisma.customer.groupBy({
    by: ['business_name', 'gstin'],
    where: {
      customer_type: 'B2B',
      account_status: 'Active',
      business_name: { not: null },
    },
    _count: { _all: true },
    orderBy: [{ business_name: 'asc' }],
  });
  const rows = groups
    .filter((g) => g.business_name && g.business_name.trim())
    .map((g) => ({
      business_name: g.business_name,
      gstin: g.gstin || null,
      contact_count: g._count._all,
    }));
  res.json({ data: rows });
}));

// ---------------------------------------------------------------
// GET /api/admin/users — list (paginated, searchable, filterable)
// ---------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const where = {};
  // Filter dropdown picks a single tile permission to filter by — rows match
  // if they hold that permission anywhere in their permissions[] set.
  if (req.query.permission) where.permissions = { has: String(req.query.permission) };
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.q) {
    where.OR = [
      { full_name: { contains: String(req.query.q), mode: 'insensitive' } },
      { email: { contains: String(req.query.q), mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.adminUser.count({ where }),
    prisma.adminUser.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  res.json({
    data: rows.map(safe),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
}));

// ---------------------------------------------------------------
// POST /api/admin/users — create
// ---------------------------------------------------------------
router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const existing = await prisma.adminUser.findUnique({ where: { email: req.body.email } });
  if (existing) conflict('Admin with that email already exists');

  await assertCategoriesExist(req.body.category_scope);
  await assertBusinessNameExists(req.body.scoped_business_name);

  const created = await prisma.adminUser.create({
    data: {
      full_name: req.body.full_name,
      email: req.body.email,
      password_hash: await bcrypt.hash(req.body.password, 10),
      permissions: req.body.permissions,
      category_scope: req.body.category_scope,
      scoped_business_name: (req.body.scoped_business_name || '').trim() || null,
    },
  });

  audit({
    action: 'admin.user.create',
    meta: {
      created_admin_id: created.admin_id,
      created_email: created.email,
      created_permissions: created.permissions,
      created_category_scope: created.category_scope,
      created_scoped_business_name: created.scoped_business_name,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.status(201).json({ data: safe(created) });
}));

// ---------------------------------------------------------------
// PUT /api/admin/users/:id — edit name / permissions / status
// ---------------------------------------------------------------
router.put('/:id', validate(updateSchema), asyncHandler(async (req, res) => {
  const target = await prisma.adminUser.findUnique({ where: { admin_id: req.params.id } });
  if (!target) notFound('Admin not found');

  const isSelf = target.admin_id === req.admin.admin_id;
  if (isSelf) {
    if (req.body.permissions && !samePermissions(req.body.permissions, target.permissions)) {
      badRequest('You cannot change your own permissions');
    }
    if (req.body.category_scope
        && !samePermissions(req.body.category_scope, target.category_scope || [])) {
      badRequest('You cannot change your own category scope');
    }
    if (req.body.status && req.body.status !== target.status) {
      badRequest('You cannot change your own status');
    }
    // Self-protection: a scoped admin must not be able to remove or
    // re-aim their own B2B restriction. Only an unscoped admin (typically
    // SuperAdmin) can change someone's scope.
    if (Object.prototype.hasOwnProperty.call(req.body, 'scoped_business_name')
        && ((req.body.scoped_business_name || '').trim() || null) !== (target.scoped_business_name || null)) {
      badRequest('You cannot change your own B2B scope');
    }
  }

  if (req.body.category_scope) await assertCategoriesExist(req.body.category_scope);
  if (Object.prototype.hasOwnProperty.call(req.body, 'scoped_business_name')) {
    await assertBusinessNameExists(req.body.scoped_business_name);
  }

  // Lockout guard: if the target currently holds 'admin-users' AND the patch
  // would strip it (either by removing the permission or disabling the
  // account), refuse when only one such admin remains. Without this check,
  // a SuperAdmin could remove their own ability to create more admins.
  const targetCanManageAdmins = target.permissions?.includes('admin-users');
  if (targetCanManageAdmins) {
    const losingAdminUsers = req.body.permissions && !req.body.permissions.includes('admin-users');
    if (losingAdminUsers) {
      const remaining = await countActiveAdminUsersHolders();
      if (remaining <= 1) badRequest('Cannot remove "Admin Users" permission from the only admin who has it');
    }
    if (req.body.status === 'Disabled') {
      const remaining = await countActiveAdminUsersHolders();
      if (remaining <= 1) badRequest('Cannot disable the only admin who can manage admin accounts');
    }
  }

  // Normalise scope-clearing: an empty string on the wire means "remove
  // the scope", which Prisma writes via explicit null.
  const dataPatch = { ...req.body };
  if (Object.prototype.hasOwnProperty.call(dataPatch, 'scoped_business_name')) {
    const trimmed = (dataPatch.scoped_business_name || '').trim();
    dataPatch.scoped_business_name = trimmed || null;
  }
  const updated = await prisma.adminUser.update({
    where: { admin_id: req.params.id },
    data: dataPatch,
  });

  // Disabling an admin should also kick them out — kill their sessions.
  if (req.body.status === 'Disabled') {
    await prisma.adminSession.deleteMany({ where: { admin_id: req.params.id } });
  }

  audit({
    action: 'admin.user.update',
    meta: {
      target_admin_id: target.admin_id,
      target_email: target.email,
      changes: req.body,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.json({ data: safe(updated) });
}));

// ---------------------------------------------------------------
// PUT /api/admin/users/:id/password — reset (force new password)
// ---------------------------------------------------------------
router.put('/:id/password', validate(resetPasswordSchema), asyncHandler(async (req, res) => {
  const target = await prisma.adminUser.findUnique({ where: { admin_id: req.params.id } });
  if (!target) notFound('Admin not found');

  await prisma.adminUser.update({
    where: { admin_id: req.params.id },
    data: { password_hash: await bcrypt.hash(req.body.password, 10) },
  });

  // Invalidate every session for the target — they must log in with new password.
  await prisma.adminSession.deleteMany({ where: { admin_id: req.params.id } });

  audit({
    action: 'admin.user.password_reset',
    meta: {
      target_admin_id: target.admin_id,
      target_email: target.email,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------
// DELETE /api/admin/users/:id — soft-disable
// ---------------------------------------------------------------
router.delete('/:id', asyncHandler(async (req, res) => {
  const target = await prisma.adminUser.findUnique({ where: { admin_id: req.params.id } });
  if (!target) notFound('Admin not found');

  if (target.admin_id === req.admin.admin_id) {
    badRequest('You cannot disable your own account');
  }
  if (target.permissions?.includes('admin-users')) {
    const remaining = await countActiveAdminUsersHolders();
    if (remaining <= 1) badRequest('Cannot disable the only admin who can manage admin accounts');
  }

  await prisma.adminUser.update({
    where: { admin_id: req.params.id },
    data: { status: 'Disabled' },
  });
  await prisma.adminSession.deleteMany({ where: { admin_id: req.params.id } });

  audit({
    action: 'admin.user.disable',
    meta: {
      target_admin_id: target.admin_id,
      target_email: target.email,
      by_admin_id: req.admin.admin_id,
      by_admin_email: req.admin.email,
    },
    ip: req.ip,
  });

  res.json({ data: { ok: true } });
}));

export default router;
