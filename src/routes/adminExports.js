// Admin report exports — Excel + PDF for every record-bearing admin section.
// Mounted at /api/admin/exports.
//
// Per-tile permission is enforced per resource so an admin can only export
// data they could already see in the UI. Always returns the FULL table —
// filters/pagination on the listing endpoints don't apply here. This is the
// product decision (BRD §15 reporting): "give me everything, I'll filter in
// Excel."
//
// URL pattern: GET /api/admin/exports/:resource?format=xlsx|pdf
//   resource ∈ orders | products | categories | coupons | customers
//            | reviews | admin-users | reports
//
// Each resource handler is responsible for:
//   1. Declaring its column set (columns drive both XLSX and PDF output via
//      lib/exports — single source of truth so the two formats can't drift).
//   2. Fetching the full table.
//   3. Mapping rows into the shape the column keys expect.

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requirePermission, scopeWhere, categoryScopeWhere, getAdminCategoryScope, orderB2BScopeWhere, customerB2BScopeWhere } from '../middleware/adminAuth.js';
import { sendXlsx, sendPdf, sendKpiXlsx, sendKpiPdf, pickFormat } from '../lib/exports.js';

const router = Router();

const num = (d) => (d == null ? 0 : Number(d));
const today = () => new Date().toISOString().slice(0, 10);

// Branded subtitle line that goes onto every table-style export.
const subtitleFor = (recordCount) =>
  `Redlook Admin · ${recordCount} record${recordCount === 1 ? '' : 's'} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// ==============================================================
// Orders
// ==============================================================
const orderColumns = [
  { key: 'order_id',        header: 'Order ID',        width: 36 },
  { key: 'order_date',      header: 'Order Date',      width: 18, format: 'datetime' },
  { key: 'customer_name',   header: 'Customer',        width: 24 },
  { key: 'customer_email',  header: 'Email',           width: 28 },
  { key: 'customer_phone',  header: 'Phone',           width: 14 },
  { key: 'item_count',      header: 'Items',           width: 8,  format: 'number' },
  { key: 'subtotal',        header: 'Subtotal',        width: 14, format: 'currency' },
  { key: 'discount',        header: 'Discount',        width: 12, format: 'currency' },
  { key: 'tax',             header: 'Tax',             width: 10, format: 'currency' },
  { key: 'delivery_charge', header: 'Delivery',        width: 12, format: 'currency' },
  { key: 'total_amount',    header: 'Total',           width: 14, format: 'currency' },
  { key: 'payment_method',  header: 'Payment Method',  width: 14 },
  { key: 'payment_status',  header: 'Payment Status',  width: 14 },
  { key: 'order_status',    header: 'Order Status',    width: 16 },
  { key: 'delivery_slot',   header: 'Delivery Slot',   width: 22 },
  { key: 'city',            header: 'City',            width: 16 },
  { key: 'state',           header: 'State',           width: 16 },
  { key: 'pincode',         header: 'Pincode',         width: 10 },
];

router.get('/orders', requirePermission('orders'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const orders = await prisma.order.findMany({
    where: orderB2BScopeWhere(req.admin),
    include: {
      items: { select: { quantity: true } },
      customer: { select: { full_name: true, email: true, phone: true } },
    },
    orderBy: { order_date: 'desc' },
  });

  const rows = orders.map((o) => {
    // address_snapshot is a JSON column (BRD §8.2). Defensive lookup so a
    // legacy order without the snapshot doesn't 500 the export.
    const addr = (o.address_snapshot && typeof o.address_snapshot === 'object') ? o.address_snapshot : {};
    return {
      order_id: o.order_id,
      order_date: o.order_date,
      customer_name: o.customer?.full_name || '',
      customer_email: o.customer?.email || '',
      customer_phone: o.customer?.phone || '',
      item_count: o.items.reduce((s, it) => s + num(it.quantity), 0),
      subtotal: num(o.subtotal),
      discount: num(o.discount),
      tax: num(o.tax),
      delivery_charge: num(o.delivery_charge),
      total_amount: num(o.total_amount),
      payment_method: o.payment_method,
      payment_status: o.payment_status,
      order_status: o.order_status,
      delivery_slot: o.delivery_slot,
      city: addr.city || '',
      state: addr.state || '',
      pincode: addr.pincode || '',
    };
  });

  const filename = `redlook-orders-${today()}`;
  const title = 'Orders';
  const summary = [
    { label: 'Total orders', value: rows.length },
    { label: 'Total revenue (incl. cancelled)', value: `Rs. ${rows.reduce((s, r) => s + r.total_amount, 0).toFixed(2)}` },
  ];

  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Orders', columns: orderColumns, rows, filename, title, summary });
  }
  return sendPdf(res, { columns: orderColumns, rows, filename, title, subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Products
// ==============================================================
const productColumns = [
  { key: 'product_id',     header: 'Product ID',  width: 36 },
  { key: 'name',           header: 'Name',        width: 28 },
  { key: 'category_name',  header: 'Category',    width: 18 },
  { key: 'price_per_unit', header: 'Price',       width: 12, format: 'currency' },
  { key: 'unit',           header: 'Unit',        width: 10 },
  { key: 'stock_quantity', header: 'Stock',       width: 10, format: 'number' },
  { key: 'is_organic',     header: 'Organic',     width: 10, format: 'boolean' },
  { key: 'rating',         header: 'Rating',      width: 10, format: 'number' },
  { key: 'reviews_count',  header: 'Reviews',     width: 10, format: 'number' },
  { key: 'freshness',      header: 'Freshness',   width: 16 },
  { key: 'status',         header: 'Status',      width: 12 },
  { key: 'created_at',     header: 'Created',     width: 16, format: 'date' },
];

router.get('/products', requirePermission('products'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const products = await prisma.product.findMany({
    where: scopeWhere(req.admin),
    include: { category: { select: { name: true } } },
    orderBy: { created_at: 'desc' },
  });

  const rows = products.map((p) => ({
    product_id: p.product_id,
    name: p.name,
    category_name: p.category?.name || p.category_id,
    price_per_unit: num(p.price_per_unit),
    unit: p.unit,
    stock_quantity: num(p.stock_quantity),
    is_organic: !!p.is_organic,
    rating: num(p.rating),
    reviews_count: p.reviews_count,
    freshness: p.freshness,
    status: p.status,
    created_at: p.created_at,
  }));

  const summary = [
    { label: 'Total products', value: rows.length },
    { label: 'Active', value: rows.filter((r) => r.status === 'Active').length },
    { label: 'Out of stock', value: rows.filter((r) => r.stock_quantity === 0).length },
  ];
  const filename = `redlook-products-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Products', columns: productColumns, rows, filename, title: 'Products', summary });
  }
  return sendPdf(res, { columns: productColumns, rows, filename, title: 'Products', subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Categories
// ==============================================================
const categoryColumns = [
  { key: 'category_id',         header: 'Slug',          width: 18 },
  { key: 'name',                header: 'Name',          width: 22 },
  { key: 'icon',                header: 'Icon',          width: 8 },
  { key: 'parent_category_id',  header: 'Parent',        width: 18 },
  { key: 'product_count',       header: 'Products',      width: 12, format: 'number' },
];

router.get('/categories', requirePermission('categories'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const cats = await prisma.category.findMany({
    where: categoryScopeWhere(req.admin),
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  const rows = cats.map((c) => ({
    category_id: c.category_id,
    name: c.name,
    icon: c.icon,
    parent_category_id: c.parent_category_id || '',
    product_count: c._count.products,
  }));

  const summary = [{ label: 'Total categories', value: rows.length }];
  const filename = `redlook-categories-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Categories', columns: categoryColumns, rows, filename, title: 'Categories', summary });
  }
  return sendPdf(res, { columns: categoryColumns, rows, filename, title: 'Categories', subtitle: subtitleFor(rows.length), summary, orientation: 'portrait' });
}));

// ==============================================================
// Coupons
// ==============================================================
const couponColumns = [
  { key: 'code',         header: 'Code',         width: 16 },
  { key: 'type',         header: 'Type',         width: 10 },
  { key: 'value',        header: 'Value',        width: 12, format: 'number' },
  { key: 'min_order',    header: 'Min Order',    width: 12, format: 'currency' },
  { key: 'used_count',   header: 'Used',         width: 10, format: 'number' },
  { key: 'max_uses',     header: 'Max Uses',     width: 10, format: 'number' },
  { key: 'valid_from',   header: 'Valid From',   width: 14, format: 'date' },
  { key: 'valid_until',  header: 'Valid Until',  width: 14, format: 'date' },
  { key: 'is_active',    header: 'Active',       width: 10, format: 'boolean' },
  { key: 'status',       header: 'Status',       width: 12 },
];

// Mirrors deriveStatus() in adminCoupons.js. Duplicated rather than
// imported to keep the export module independent of route internals.
function deriveCouponStatus(c, now = new Date()) {
  if (!c.is_active) return 'Inactive';
  if (c.valid_from && new Date(c.valid_from) > now) return 'Upcoming';
  if (c.valid_until && new Date(c.valid_until) < now) return 'Expired';
  if (c.max_uses != null && c.used_count >= c.max_uses) return 'Exhausted';
  return 'Active';
}

router.get('/coupons', requirePermission('coupons'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const rows = (await prisma.coupon.findMany({ orderBy: { valid_from: 'desc' } })).map((c) => ({
    code: c.code,
    type: c.type,
    value: num(c.value),
    min_order: num(c.min_order),
    used_count: c.used_count,
    max_uses: c.max_uses ?? '',
    valid_from: c.valid_from,
    valid_until: c.valid_until,
    is_active: c.is_active,
    status: deriveCouponStatus(c),
  }));

  const summary = [
    { label: 'Total coupons', value: rows.length },
    { label: 'Active', value: rows.filter((r) => r.status === 'Active').length },
    { label: 'Expired', value: rows.filter((r) => r.status === 'Expired').length },
  ];
  const filename = `redlook-coupons-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Coupons', columns: couponColumns, rows, filename, title: 'Coupons', summary });
  }
  return sendPdf(res, { columns: couponColumns, rows, filename, title: 'Coupons', subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Customers
// ==============================================================
const customerColumns = [
  { key: 'customer_id',     header: 'Customer ID',    width: 36 },
  { key: 'full_name',       header: 'Name',           width: 24 },
  { key: 'email',           header: 'Email',          width: 28 },
  { key: 'phone',           header: 'Phone',          width: 14 },
  { key: 'account_status',  header: 'Status',         width: 12 },
  { key: 'email_verified',  header: 'Email Verified', width: 14, format: 'boolean' },
  { key: 'phone_verified',  header: 'Phone Verified', width: 14, format: 'boolean' },
  { key: 'loyalty_points',  header: 'Loyalty Points', width: 14, format: 'number' },
  { key: 'gender',          header: 'Gender',         width: 10 },
  { key: 'date_of_birth',   header: 'DOB',            width: 14, format: 'date' },
  { key: 'created_at',      header: 'Joined',         width: 16, format: 'date' },
  { key: 'last_login',      header: 'Last Login',     width: 18, format: 'datetime' },
];

router.get('/customers', requirePermission('customers'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const customers = await prisma.customer.findMany({
    where: customerB2BScopeWhere(req.admin),
    orderBy: { created_at: 'desc' },
  });
  const rows = customers.map((c) => ({
    customer_id: c.customer_id,
    full_name: c.full_name,
    email: c.email,
    phone: c.phone,
    account_status: c.account_status,
    email_verified: c.email_verified,
    phone_verified: c.phone_verified,
    loyalty_points: num(c.loyalty_points),
    gender: c.gender || '',
    date_of_birth: c.date_of_birth,
    created_at: c.created_at,
    last_login: c.last_login,
  }));

  const summary = [
    { label: 'Total customers', value: rows.length },
    { label: 'Active', value: rows.filter((r) => r.account_status === 'Active').length },
  ];
  const filename = `redlook-customers-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Customers', columns: customerColumns, rows, filename, title: 'Customers', summary });
  }
  return sendPdf(res, { columns: customerColumns, rows, filename, title: 'Customers', subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Reviews
// ==============================================================
const reviewColumns = [
  { key: 'review_id',      header: 'Review ID',     width: 36 },
  { key: 'product_name',   header: 'Product',       width: 24 },
  { key: 'customer_name',  header: 'Customer',      width: 22 },
  { key: 'customer_email', header: 'Email',         width: 28 },
  { key: 'rating',         header: 'Rating',        width: 10, format: 'number' },
  { key: 'comment',        header: 'Comment',       width: 60 },
  { key: 'created_at',     header: 'Date',          width: 18, format: 'datetime' },
];

router.get('/reviews', requirePermission('reviews'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const reviews = await prisma.review.findMany({
    include: {
      customer: { select: { full_name: true, email: true } },
      product: { select: { name: true } },
    },
    orderBy: { created_at: 'desc' },
  });
  const rows = reviews.map((r) => ({
    review_id: r.review_id,
    product_name: r.product?.name || '',
    customer_name: r.customer?.full_name || '',
    customer_email: r.customer?.email || '',
    rating: r.rating,
    comment: r.comment || '',
    created_at: r.created_at,
  }));

  const summary = [
    { label: 'Total reviews', value: rows.length },
    { label: 'Average rating', value: rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(2) : '—' },
  ];
  const filename = `redlook-reviews-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Reviews', columns: reviewColumns, rows, filename, title: 'Reviews', summary });
  }
  return sendPdf(res, { columns: reviewColumns, rows, filename, title: 'Reviews', subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Admin Users
// ==============================================================
const adminUserColumns = [
  { key: 'admin_id',     header: 'Admin ID',     width: 36 },
  { key: 'full_name',    header: 'Name',         width: 24 },
  { key: 'email',        header: 'Email',        width: 28 },
  { key: 'status',       header: 'Status',       width: 12 },
  { key: 'permissions',  header: 'Permissions',  width: 60 },
  { key: 'created_at',   header: 'Created',      width: 16, format: 'date' },
  { key: 'last_login',   header: 'Last Login',   width: 18, format: 'datetime' },
];

router.get('/admin-users', requirePermission('admin-users'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const admins = await prisma.adminUser.findMany({ orderBy: { created_at: 'desc' } });
  const rows = admins.map((a) => ({
    admin_id: a.admin_id,
    full_name: a.full_name,
    email: a.email,
    status: a.status,
    permissions: a.permissions, // exporter joins with ", "
    created_at: a.created_at,
    last_login: a.last_login,
  }));

  const summary = [
    { label: 'Total admins', value: rows.length },
    { label: 'Active', value: rows.filter((r) => r.status === 'Active').length },
  ];
  const filename = `redlook-admin-users-${today()}`;
  if (format === 'xlsx') {
    return sendXlsx(res, { sheetName: 'Admin Users', columns: adminUserColumns, rows, filename, title: 'Admin Users', summary });
  }
  return sendPdf(res, { columns: adminUserColumns, rows, filename, title: 'Admin Users', subtitle: subtitleFor(rows.length), summary });
}));

// ==============================================================
// Reports — multi-section KPI export (sales + inventory + customers + revenue)
// All-time data; the in-app reports page is date-scoped, but a downloadable
// snapshot is most useful as a complete view.
// ==============================================================
router.get('/reports', requirePermission('reports'), asyncHandler(async (req, res) => {
  const format = pickFormat(req.query);
  if (!format) badRequest('format must be xlsx or pdf');

  const [orders, products, customers, allOrders] = await Promise.all([
    prisma.order.findMany({
      where: { order_status: { not: 'Cancelled' }, ...orderB2BScopeWhere(req.admin) },
      include: { items: true, customer: { select: { full_name: true, email: true } } },
      orderBy: { order_date: 'desc' },
    }),
    // Products feed the inventory-by-category + low-stock sections — scope-filter
    // so a category-restricted admin sees only their categories. Top-products
    // is filtered separately below (it lives in the order-items aggregate).
    prisma.product.findMany({ where: scopeWhere(req.admin), include: { category: { select: { name: true } } } }),
    prisma.customer.findMany({
      where: customerB2BScopeWhere(req.admin),
      select: { customer_id: true, account_status: true, email_verified: true, phone_verified: true, created_at: true },
    }),
    prisma.order.findMany({ where: orderB2BScopeWhere(req.admin), select: { order_status: true } }),
  ]);

  const adminScope = getAdminCategoryScope(req.admin);

  // -- Sales KPIs --
  const revenue = orders.reduce((s, o) => s + num(o.total_amount), 0);
  const aov = orders.length ? revenue / orders.length : 0;
  const cancelled = allOrders.filter((o) => o.order_status === 'Cancelled').length;

  // -- Inventory --
  const active = products.filter((p) => p.status === 'Active');
  const stockValue = active.reduce((s, p) => s + num(p.stock_quantity) * num(p.price_per_unit), 0);
  const outOfStock = active.filter((p) => num(p.stock_quantity) === 0);
  const lowStock = active.filter((p) => num(p.stock_quantity) > 0 && num(p.stock_quantity) <= 10);

  // -- Customers --
  const verifiedBoth = customers.filter((c) => c.email_verified && c.phone_verified).length;

  // -- Top products by revenue --
  const productAgg = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      const cur = productAgg.get(it.product_id) || { product_id: it.product_id, name: it.name, units: 0, revenue: 0 };
      cur.units += num(it.quantity);
      cur.revenue += num(it.line_total);
      productAgg.set(it.product_id, cur);
    }
  }
  // Scope filter: only keep aggregates for products in the admin's categories.
  // We already loaded the in-scope product set above, so reuse it.
  if (adminScope) {
    const allowedIds = new Set(products.map((p) => p.product_id));
    for (const id of [...productAgg.keys()]) {
      if (!allowedIds.has(id)) productAgg.delete(id);
    }
  }
  const topProducts = [...productAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 25);

  // -- Top customers --
  const custAgg = new Map();
  for (const o of orders) {
    const cur = custAgg.get(o.customer_id) || {
      customer_id: o.customer_id,
      name: o.customer?.full_name || '',
      email: o.customer?.email || '',
      orders: 0,
      spend: 0,
    };
    cur.orders += 1;
    cur.spend += num(o.total_amount);
    custAgg.set(o.customer_id, cur);
  }
  const topCustomers = [...custAgg.values()].sort((a, b) => b.spend - a.spend).slice(0, 25);

  // -- Payment-method split --
  const methodMap = new Map();
  for (const o of orders) {
    const cur = methodMap.get(o.payment_method) || { method: o.payment_method, count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += num(o.total_amount);
    methodMap.set(o.payment_method, cur);
  }
  const byPaymentMethod = [...methodMap.values()].sort((a, b) => b.revenue - a.revenue);

  // -- Status breakdown --
  const statusCounts = {};
  for (const o of allOrders) statusCounts[o.order_status] = (statusCounts[o.order_status] || 0) + 1;
  const byStatus = Object.entries(statusCounts).map(([status, count]) => ({ status, count }));

  // -- Inventory by category --
  const catMap = new Map();
  for (const p of active) {
    const key = p.category_id;
    const cur = catMap.get(key) || { category: p.category?.name || key, products: 0, stock_value: 0 };
    cur.products += 1;
    cur.stock_value += num(p.stock_quantity) * num(p.price_per_unit);
    catMap.set(key, cur);
  }
  const byCategory = [...catMap.values()].sort((a, b) => b.stock_value - a.stock_value);

  const sections = [
    {
      heading: 'Headline KPIs',
      kind: 'kpi-grid',
      items: [
        { label: 'Net Revenue (delivered/in-flight)', value: `Rs. ${revenue.toFixed(2)}` },
        { label: 'Orders (excl. cancelled)', value: String(orders.length) },
        { label: 'Average Order Value', value: `Rs. ${aov.toFixed(2)}` },
        { label: 'Cancelled Orders', value: String(cancelled) },
        { label: 'Total Customers', value: String(customers.length) },
        { label: 'Active Customers', value: String(customers.filter((c) => c.account_status === 'Active').length) },
        { label: 'Fully-Verified Customers', value: String(verifiedBoth) },
        { label: 'Active Products', value: String(active.length) },
        { label: 'Out of Stock', value: String(outOfStock.length) },
        { label: 'Low Stock (≤10)', value: String(lowStock.length) },
        { label: 'Stock Value (active)', value: `Rs. ${stockValue.toFixed(2)}` },
        { label: 'Total SKUs', value: String(products.length) },
      ],
    },
    {
      heading: 'Order Status',
      kind: 'table',
      columns: [
        { key: 'status', header: 'Status', width: 20 },
        { key: 'count',  header: 'Count',  width: 10, format: 'number' },
      ],
      rows: byStatus,
    },
    {
      heading: 'Payment Methods',
      kind: 'table',
      columns: [
        { key: 'method',  header: 'Method',  width: 16 },
        { key: 'count',   header: 'Orders',  width: 10, format: 'number' },
        { key: 'revenue', header: 'Revenue', width: 16, format: 'currency' },
      ],
      rows: byPaymentMethod,
    },
    {
      heading: 'Inventory by Category',
      kind: 'table',
      columns: [
        { key: 'category',    header: 'Category',    width: 24 },
        { key: 'products',    header: 'Products',    width: 12, format: 'number' },
        { key: 'stock_value', header: 'Stock Value', width: 16, format: 'currency' },
      ],
      rows: byCategory,
    },
    {
      heading: 'Top Products',
      kind: 'table',
      columns: [
        { key: 'name',    header: 'Product', width: 30 },
        { key: 'units',   header: 'Units',   width: 10, format: 'number' },
        { key: 'revenue', header: 'Revenue', width: 16, format: 'currency' },
      ],
      rows: topProducts,
    },
    {
      heading: 'Top Customers',
      kind: 'table',
      columns: [
        { key: 'name',   header: 'Customer', width: 24 },
        { key: 'email',  header: 'Email',    width: 28 },
        { key: 'orders', header: 'Orders',   width: 10, format: 'number' },
        { key: 'spend',  header: 'Spend',    width: 16, format: 'currency' },
      ],
      rows: topCustomers,
    },
  ];

  const title = 'Redlook Reports — All-Time';
  const subtitle = `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const filename = `redlook-reports-${today()}`;

  if (format === 'xlsx') {
    return sendKpiXlsx(res, { filename, title, subtitle, sections });
  }
  return sendKpiPdf(res, { filename, title, subtitle, sections });
}));

export default router;
