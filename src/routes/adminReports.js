// Admin reports & analytics (BRD FR-ADM-06). Mounted at /api/admin/reports.
//
// Read-only — all three roles can view reports (Support reps need them
// for customer-service context just as much as Operations does).
//
// Date filtering: ?from=ISO&to=ISO. Both optional; default = last 30 days.
// Time-series buckets are computed in JS from a single findMany — fine for
// the order volumes we expect for a while. If we ever need millions of
// orders per window, swap to a $queryRaw with date_trunc.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requirePermission, scopeWhere, getAdminCategoryScope, orderB2BScopeWhere, customerB2BScopeWhere, nestedCustomerB2BScopeWhere } from '../middleware/adminAuth.js';

const router = Router();

// Default window = last 30 days, inclusive of today.
function resolveRange(query) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  const from = query.from
    ? new Date(String(query.from))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// "YYYY-MM-DD" string keyed by UTC date for stable bucket grouping.
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// Generate every day in the range so the chart doesn't have gaps.
function eachDay(from, to) {
  const out = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur <= end) {
    out.push(dayKey(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const num = (d) => Number(d || 0);

// ---------------------------------------------------------------
// GET /api/admin/reports/sales
// Order volume, revenue, daily series, top products, top customers,
// and order-status breakdown — all over the requested window.
// ---------------------------------------------------------------
router.get('/sales', requirePermission('reports'), asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);

  const orders = await prisma.order.findMany({
    where: { order_date: { gte: from, lte: to }, ...orderB2BScopeWhere(req.admin) },
    include: { items: true, customer: { select: { full_name: true, email: true } } },
    orderBy: { order_date: 'desc' },
  });

  const nonCancelled = orders.filter((o) => o.order_status !== 'Cancelled');

  // Totals (revenue excludes cancelled — those never charged the customer).
  const revenue = nonCancelled.reduce((s, o) => s + num(o.total_amount), 0);
  const totals = {
    order_count: orders.length,
    completed_order_count: nonCancelled.length,
    cancelled_order_count: orders.length - nonCancelled.length,
    revenue,
    avg_order_value: nonCancelled.length ? revenue / nonCancelled.length : 0,
  };

  // Daily series: include every day in window so charts have stable axes.
  const buckets = Object.fromEntries(eachDay(from, to).map((d) => [d, { date: d, orders: 0, revenue: 0 }]));
  for (const o of nonCancelled) {
    const k = dayKey(o.order_date);
    if (buckets[k]) {
      buckets[k].orders += 1;
      buckets[k].revenue += num(o.total_amount);
    }
  }
  const daily = Object.values(buckets);

  // Top products by units sold + revenue.
  const productAgg = new Map();
  for (const o of nonCancelled) {
    for (const it of o.items) {
      const cur = productAgg.get(it.product_id) || { product_id: it.product_id, name: it.name, image: it.image, units: 0, revenue: 0 };
      cur.units += num(it.quantity);
      cur.revenue += num(it.line_total);
      productAgg.set(it.product_id, cur);
    }
  }
  // Scope-filter top products for category-restricted admins so the view
  // matches what they see on the Products tile.
  const scope = getAdminCategoryScope(req.admin);
  if (scope && productAgg.size > 0) {
    const ids = [...productAgg.keys()];
    const inScopeProducts = await prisma.product.findMany({
      where: { product_id: { in: ids }, category_id: { in: scope } },
      select: { product_id: true },
    });
    const allowedIds = new Set(inScopeProducts.map((p) => p.product_id));
    for (const id of [...productAgg.keys()]) {
      if (!allowedIds.has(id)) productAgg.delete(id);
    }
  }
  const topProducts = [...productAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Top customers by lifetime-in-window spend.
  const customerAgg = new Map();
  for (const o of nonCancelled) {
    const key = o.customer_id;
    const cur = customerAgg.get(key) || { customer_id: key, full_name: o.customer?.full_name, email: o.customer?.email, orders: 0, spend: 0 };
    cur.orders += 1;
    cur.spend += num(o.total_amount);
    customerAgg.set(key, cur);
  }
  const topCustomers = [...customerAgg.values()].sort((a, b) => b.spend - a.spend).slice(0, 10);

  // Status breakdown (includes cancelled so admins see the funnel).
  const byStatus = {};
  for (const o of orders) byStatus[o.order_status] = (byStatus[o.order_status] || 0) + 1;

  res.json({
    data: {
      range: { from, to },
      totals,
      daily,
      topProducts,
      topCustomers,
      byStatus,
    },
  });
}));

// ---------------------------------------------------------------
// GET /api/admin/reports/inventory
// Point-in-time snapshot — date range doesn't apply.
// Stock value = sum(stock_quantity × price_per_unit) for active products.
// ---------------------------------------------------------------
router.get('/inventory', requirePermission('reports'), asyncHandler(async (req, res) => {
  const threshold = Math.max(1, parseInt(req.query.threshold, 10) || 10);

  const products = await prisma.product.findMany({
    where: scopeWhere(req.admin),
    include: { category: { select: { name: true, icon: true } } },
  });

  const active = products.filter((p) => p.status === 'Active');
  const stockValue = active.reduce((s, p) => s + num(p.stock_quantity) * num(p.price_per_unit), 0);

  const totals = {
    total_products: products.length,
    active_count: active.length,
    inactive_count: products.length - active.length,
    low_stock_count: active.filter((p) => num(p.stock_quantity) > 0 && num(p.stock_quantity) <= threshold).length,
    out_of_stock_count: active.filter((p) => num(p.stock_quantity) === 0).length,
    stock_value: stockValue,
    threshold,
  };

  // By-category breakdown — count + stock value per category.
  const byCategoryMap = new Map();
  for (const p of active) {
    const key = p.category_id;
    const cur = byCategoryMap.get(key) || {
      category_id: key,
      category_name: p.category?.name || key,
      icon: p.category?.icon || '',
      product_count: 0,
      stock_value: 0,
    };
    cur.product_count += 1;
    cur.stock_value += num(p.stock_quantity) * num(p.price_per_unit);
    byCategoryMap.set(key, cur);
  }
  const byCategory = [...byCategoryMap.values()].sort((a, b) => b.stock_value - a.stock_value);

  // Low-stock list — what to restock next, prioritized by lowest stock.
  const lowStockItems = active
    .filter((p) => num(p.stock_quantity) <= threshold)
    .sort((a, b) => num(a.stock_quantity) - num(b.stock_quantity))
    .slice(0, 20)
    .map((p) => ({
      product_id: p.product_id,
      name: p.name,
      image: p.image,
      category_name: p.category?.name || p.category_id,
      stock_quantity: num(p.stock_quantity),
      unit: p.unit,
      price_per_unit: num(p.price_per_unit),
    }));

  res.json({ data: { totals, byCategory, lowStockItems } });
}));

// ---------------------------------------------------------------
// GET /api/admin/reports/customers
// Signup trends, active customers, verification stats, status mix.
// ---------------------------------------------------------------
router.get('/customers', requirePermission('reports'), asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);

  const customerScope = customerB2BScopeWhere(req.admin);
  const [allCustomers, newInWindow, ordersInWindow, statusGroups] = await Promise.all([
    prisma.customer.findMany({
      where: customerScope,
      select: { customer_id: true, email_verified: true, phone_verified: true },
    }),
    prisma.customer.findMany({
      where: { created_at: { gte: from, lte: to }, ...customerScope },
      select: { customer_id: true, created_at: true },
    }),
    prisma.order.findMany({
      where: {
        order_date: { gte: from, lte: to },
        order_status: { not: 'Cancelled' },
        ...orderB2BScopeWhere(req.admin),
      },
      select: { customer_id: true },
    }),
    prisma.customer.groupBy({
      by: ['account_status'],
      where: customerScope,
      _count: { account_status: true },
    }),
  ]);

  const activeBuyersInWindow = new Set(ordersInWindow.map((o) => o.customer_id));

  const verification = {
    email_verified: allCustomers.filter((c) => c.email_verified).length,
    phone_verified: allCustomers.filter((c) => c.phone_verified).length,
    both_verified: allCustomers.filter((c) => c.email_verified && c.phone_verified).length,
    total: allCustomers.length,
  };

  const statusBreakdown = { Active: 0, Suspended: 0, Inactive: 0, Deleted: 0 };
  for (const g of statusGroups) statusBreakdown[g.account_status] = g._count.account_status;

  const totals = {
    total_customers: allCustomers.length,
    new_in_window: newInWindow.length,
    active_in_window: activeBuyersInWindow.size,
  };

  // Daily signups across the window — even days with zero so the chart axis is stable.
  const buckets = Object.fromEntries(eachDay(from, to).map((d) => [d, { date: d, signups: 0 }]));
  for (const c of newInWindow) {
    const k = dayKey(c.created_at);
    if (buckets[k]) buckets[k].signups += 1;
  }
  const dailySignups = Object.values(buckets);

  res.json({ data: { range: { from, to }, totals, dailySignups, verification, statusBreakdown } });
}));

// ---------------------------------------------------------------
// GET /api/admin/reports/revenue
// Financial breakdown — gross vs discount/tax/delivery/net,
// payment-method split, top coupons used in window.
// ---------------------------------------------------------------
router.get('/revenue', requirePermission('reports'), asyncHandler(async (req, res) => {
  const { from, to } = resolveRange(req.query);

  const orders = await prisma.order.findMany({
    where: {
      order_date: { gte: from, lte: to },
      order_status: { not: 'Cancelled' },
      ...orderB2BScopeWhere(req.admin),
    },
    select: {
      subtotal: true, discount: true, delivery_charge: true, tax: true, total_amount: true,
      payment_method: true, payment_status: true,
    },
  });

  // gross subtotal, what was given away, what was collected for taxes/delivery, net total
  const totals = orders.reduce(
    (acc, o) => ({
      gross: acc.gross + num(o.subtotal),
      discount: acc.discount + num(o.discount),
      tax: acc.tax + num(o.tax),
      delivery: acc.delivery + num(o.delivery_charge),
      net: acc.net + num(o.total_amount),
      orders: acc.orders + 1,
    }),
    { gross: 0, discount: 0, tax: 0, delivery: 0, net: 0, orders: 0 },
  );

  // Payment-method split — count + revenue per method.
  const methodMap = new Map();
  for (const o of orders) {
    const cur = methodMap.get(o.payment_method) || { method: o.payment_method, count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += num(o.total_amount);
    methodMap.set(o.payment_method, cur);
  }
  const byPaymentMethod = [...methodMap.values()].sort((a, b) => b.revenue - a.revenue);

  // Coupon redemption (BRD §10.6): orders.discount > 0 indicates a coupon
  // was used at checkout. We don't currently store the coupon_id on the
  // order — when that's added we can attribute discount per code here.
  const ordersWithDiscount = orders.filter((o) => num(o.discount) > 0);
  const couponRedemptions = {
    redeemed_orders: ordersWithDiscount.length,
    total_discount_given: ordersWithDiscount.reduce((s, o) => s + num(o.discount), 0),
  };

  res.json({ data: { range: { from, to }, totals, byPaymentMethod, couponRedemptions } });
}));

export default router;
