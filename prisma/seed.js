// Seed script — populates Categories, Products, demo coupons, and a default
// super-admin account.
// Idempotent: safe to re-run; uses upserts.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Saree + Lehenga catalog for Redlook. The schema still carries vegetable-
// coded columns (`unit`, `is_organic`, `freshness`) inherited from the
// FreshKart fork — we reuse them with luxury-apparel semantics until a
// future schema refactor:
//   unit       → 'piece' for every item (one drape sold at a time; blouse
//                size and stitching belong on a future variants table)
//   is_organic → 'Premium / Heritage' flag (true = handloom or signature
//                bridal piece, surfaced as a gold "PREMIUM" badge)
//   freshness  → drop label like "New Arrival" / "Bestseller" /
//                "Bridal Couture" / "Festive Edit" so the storefront
//                badge reads as a curated tag, not a date.
const CATEGORIES = [
  { category_id: 'sarees',   name: 'Sarees',        icon: '🥻' },
  { category_id: 'lehengas', name: 'Lehengas',      icon: '💃' },
  { category_id: 'bridal',   name: 'Bridal Couture', icon: '👰' },
  { category_id: 'festive',  name: 'Festive Edit',  icon: '✨' },
  { category_id: 'designer', name: 'Designer',      icon: '👑' },
];

const PRODUCTS = [
  { product_id: 'p1',  name: 'Banarasi Silk Saree — Crimson Zari',          category_id: 'sarees',   price_per_unit:  4999, unit: 'piece', stock_quantity: 30, is_organic: true,  image: '🥻', description: 'Hand-woven Banarasi silk in deep crimson with classic zari motifs along the border. Includes an unstitched blouse piece. Made in Varanasi by master weavers.',                rating: 4.9, reviews_count: 312, freshness: 'Bestseller' },
  { product_id: 'p2',  name: 'Kanjeevaram Pure Silk — Peacock Blue',        category_id: 'sarees',   price_per_unit:  8999, unit: 'piece', stock_quantity: 22, is_organic: true,  image: '🥻', description: 'Authentic Kanjeevaram from Tamil Nadu with a contrasting gold-thread pallu. Mulberry silk, heavyweight, an heirloom drape for weddings and pujas.',                            rating: 4.9, reviews_count: 198, freshness: 'Heritage' },
  { product_id: 'p3',  name: 'Chiffon Floral Saree — Blush Pink',           category_id: 'sarees',   price_per_unit:  1799, unit: 'piece', stock_quantity: 80, is_organic: false, image: '🌸', description: 'Lightweight chiffon with a watercolour floral print and a delicate sequin border. Effortless for daytime soirées and cocktail evenings.',                                   rating: 4.5, reviews_count: 156, freshness: 'New Arrival' },
  { product_id: 'p4',  name: 'Linen Cotton Saree — Ivory & Gold',           category_id: 'sarees',   price_per_unit:  2499, unit: 'piece', stock_quantity: 60, is_organic: false, image: '🤍', description: 'Breathable linen-cotton blend in ivory with hand-painted gold motifs. Office-ready, festive enough for daytime poojas.',                                                  rating: 4.4, reviews_count: 89,  freshness: 'Festive Edit' },
  { product_id: 'p5',  name: 'Bridal Lehenga — Royal Maroon',               category_id: 'lehengas', price_per_unit: 14999, unit: 'piece', stock_quantity: 12, is_organic: true,  image: '👰', description: 'Heavily embroidered velvet lehenga in royal maroon with zardozi work, kundan accents, and a 4-metre flare. Includes choli and net dupatta.',                                rating: 5.0, reviews_count: 87,  freshness: 'Bridal Couture' },
  { product_id: 'p6',  name: 'Designer Lehenga — Emerald & Gold',           category_id: 'lehengas', price_per_unit:  9999, unit: 'piece', stock_quantity: 18, is_organic: true,  image: '💚', description: 'Raw silk lehenga in deep emerald with intricate dabka embroidery. Cocktail-ready silhouette by an emerging Mumbai atelier.',                                                rating: 4.8, reviews_count: 142, freshness: 'Designer' },
  { product_id: 'p7',  name: 'Sangeet Lehenga — Rose Gold',                 category_id: 'lehengas', price_per_unit:  6999, unit: 'piece', stock_quantity: 25, is_organic: false, image: '🌹', description: 'Net lehenga with rose-gold sequin scatter, hand-stitched blouse, and a contrasting dupatta. Made to move under sangeet lights.',                                            rating: 4.7, reviews_count: 134, freshness: 'Bestseller' },
  { product_id: 'p8',  name: 'Bridal Saree — Red Tissue Silk',              category_id: 'bridal',   price_per_unit: 12999, unit: 'piece', stock_quantity: 14, is_organic: true,  image: '❤️', description: 'Tissue silk bridal saree in classic Indian red with all-over gold gota work and a 6-inch contrast border. The wedding-day drape.',                                              rating: 4.9, reviews_count: 76,  freshness: 'Bridal Couture' },
  { product_id: 'p9',  name: 'Festive Lehenga — Sunset Orange',             category_id: 'festive',  price_per_unit:  5499, unit: 'piece', stock_quantity: 32, is_organic: false, image: '🧡', description: 'Georgette lehenga in sunset orange with mirror work and a vibrant printed dupatta. Perfect for Diwali, Karwa Chauth, and family functions.',                                rating: 4.6, reviews_count: 167, freshness: 'Festive Edit' },
  { product_id: 'p10', name: 'Anarkali Saree — Mehendi Green',              category_id: 'festive',  price_per_unit:  3499, unit: 'piece', stock_quantity: 40, is_organic: false, image: '💚', description: 'Pre-draped Anarkali-style saree in mehendi green with a heavy embellished bodice. Easy to wear; gives the saree silhouette without the pleating fuss.',                       rating: 4.5, reviews_count: 92,  freshness: 'New Arrival' },
  { product_id: 'p11', name: 'Designer Saree — Champagne Sequin',           category_id: 'designer', price_per_unit:  7499, unit: 'piece', stock_quantity: 20, is_organic: true,  image: '🍾', description: 'Champagne-toned sequin saree with a sweetheart blouse. A red-carpet drape from a Delhi-based designer for cocktail and reception nights.',                                rating: 4.8, reviews_count: 118, freshness: 'Designer' },
  { product_id: 'p12', name: 'Heirloom Saree — Pure Tussar with Madhubani', category_id: 'designer', price_per_unit:  6499, unit: 'piece', stock_quantity: 16, is_organic: true,  image: '🎨', description: 'Pure Tussar silk hand-painted with Madhubani motifs by Bihar artisans. Numbered and signed — each piece is one-of-one.',                                                   rating: 4.9, reviews_count: 64,  freshness: 'Heritage' },
];

// Demo coupons — codes match the storefront price ceiling. SAREE10 = 10%
// off ₹1999+, BRIDAL500 = flat ₹500 off ₹4999+ (covers the bridal tier).
const COUPONS = [
  { code: 'SAREE10',   type: 'PERCENT', value: 10,  min_order: 1999 },
  { code: 'BRIDAL500', type: 'FLAT',    value: 500, min_order: 4999 },
];

// Default super-admin. Override via env on first seed of a real environment;
// the seeded record is only created if no admin with this email exists yet.
// Re-running seed never overwrites password_hash, so a rotated password sticks.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@redlook.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Redlook Super Admin';

async function main() {
  console.log('Seeding categories…');
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { category_id: c.category_id },
      update: c,
      create: c,
    });
  }

  console.log('Seeding products…');
  for (const p of PRODUCTS) {
    // Mirror the legacy single image into the new gallery column so the
    // detail-page renderer can always read `images` uniformly. Admins
    // can add 2nd-5th photos via the product form after seed.
    const withImages = { ...p, images: p.image ? [p.image] : [] };
    await prisma.product.upsert({
      where: { product_id: p.product_id },
      update: withImages,
      create: withImages,
    });
  }

  // Drop any legacy categories from earlier seed shapes. Each new product
  // upsert above re-tags p1..p12 to a current saree/lehenga category, so
  // the old `leafy/root/seasonal/exotic/organic` (Freshkart era) and
  // `women/men/kids/footwear/accessories` (apparel era) rows no longer
  // have any Product pointing to them and can be safely removed.
  const LEGACY_CATEGORY_IDS = [
    'leafy', 'root', 'seasonal', 'exotic', 'organic',
    'women', 'men', 'kids', 'footwear', 'accessories',
  ];
  const dropped = await prisma.category.deleteMany({
    where: { category_id: { in: LEGACY_CATEGORY_IDS } },
  });
  if (dropped.count > 0) console.log(`  · Dropped ${dropped.count} legacy categories.`);

  console.log('Seeding coupons…');
  for (const c of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: c,
      create: c,
    });
  }
  // Drop legacy demo coupons from earlier seed shapes (Freshkart-era
  // FRESH10/NEW50 and apparel-era STYLE10/WELCOME200). Skipped silently
  // if a customer has already redeemed one (CouponRedemption FK).
  const LEGACY_COUPON_CODES = ['FRESH10', 'NEW50', 'STYLE10', 'WELCOME200'];
  try {
    const droppedCoupons = await prisma.coupon.deleteMany({
      where: { code: { in: LEGACY_COUPON_CODES } },
    });
    if (droppedCoupons.count > 0) console.log(`  · Dropped ${droppedCoupons.count} legacy coupon codes.`);
  } catch (e) {
    console.log(`  · Skipped legacy coupon cleanup (likely redeemed already): ${e.message.split('\n')[0]}`);
  }

  console.log('Seeding super-admin…');
  const existingAdmin = await prisma.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existingAdmin) {
    await prisma.adminUser.create({
      data: {
        full_name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password_hash: await bcrypt.hash(ADMIN_PASSWORD, 10),
        // Seed admin gets every tile in the catalog. Mirrors
        // ADMIN_PERMISSIONS in middleware/adminAuth.js — kept inline here
        // to avoid an import cycle through the running app. When a new
        // permission key is added there (e.g. the report split that gave
        // us 'accounting' / 'customer-report' / 'b2b-customers'), add it
        // here too or freshly-seeded super-admins will silently lack the
        // matching sidebar tile.
        permissions: [
          'admin-users', 'categories', 'coupons', 'customers',
          'orders', 'products', 'reports', 'reviews', 'settings',
          'b2b-customers',
        ],
        category_scope: [],
      },
    });
    console.log(`  ✓ Created super-admin ${ADMIN_EMAIL} (password: ${ADMIN_PASSWORD === 'Admin@123' ? 'Admin@123 — change immediately!' : '[from env]'})`);
  } else {
    console.log(`  · Super-admin ${ADMIN_EMAIL} already exists; not overwriting.`);
  }

  // Singleton settings row. Operational thresholds (min order, delivery
  // charge, etc.) are write-once via `create` so admin edits survive a
  // re-seed. Brand-facing copy — company name, hero, badges, support — is
  // force-overwritten on every seed so a fresh `npm run seed` is enough to
  // rebrand the storefront end-to-end without leaving stale FreshKart copy
  // behind. Acceptable for dev; admins editing copy in production should
  // not be running `npm run seed` there.
  console.log('Seeding business settings…');
  const REDLOOK_BRAND_COPY = {
    support_phone: '+91 80000 00000',
    support_whatsapp: '+91 80000 00000',
    support_email: 'concierge@redlook.example',
    support_message: 'Our drape consultants are online from 10 AM to 9 PM, every day. We typically reply within 10 minutes.',
    company_name: 'Redlook',
    company_tagline: 'Heritage drapes, modern grace.',
    home_announcement_text: 'Free shipping & insured delivery on orders above ₹1999',
    home_hero_features: [
      { key: 'announcement',     enabled: true,  title: 'Free shipping & insured delivery on orders above ₹1999' },
      { key: 'headline_top',     enabled: true,  title: 'Drape elegance,' },
      { key: 'headline_bottom',  enabled: true,  title: 'wear a story.' },
      { key: 'subheadline',      enabled: true,  title: 'Hand-picked Banarasi, Kanjeevaram and bridal lehenga collections from India\'s finest weavers and ateliers. Easy 7-day returns on every drape.' },
      { key: 'background_image', enabled: false, title: '' },
      { key: 'delivery',         enabled: true,  title: 'Insured nationwide delivery' },
      { key: 'freshness',        enabled: true,  title: '100% authentic handloom' },
      { key: 'speed',            enabled: true,  title: 'Concierge styling support' },
    ],
    product_detail_badges: [
      { key: 'delivery',  enabled: true, title: 'Free shipping',     subtitle: 'On orders ₹{free_delivery_over}+' },
      { key: 'returns',   enabled: true, title: 'Easy returns',      subtitle: 'Within 7 days of delivery', title_alt: 'Non-returnable', subtitle_alt: 'Bridal couture — final sale' },
      { key: 'freshness', enabled: true, title: 'Authentic handloom', subtitle: 'Verified by our weave panel' },
      { key: 'slot',      enabled: true, title: 'Earliest slot',     subtitle: '{next_slot}' },
    ],
  };
  await prisma.businessSettings.upsert({
    where: { id: 1 },
    update: REDLOOK_BRAND_COPY,
    create: {
      id: 1,
      min_order_value: 999,
      min_order_quantity: 1,
      delivery_charge: 99,
      free_delivery_over: 1999,
      delivery_slot_buffer_hours: 5,
      return_window_hours: 168,
      return_window_message: 'Easy 7-day returns on all eligible drapes. Bridal couture and made-to-measure pieces are final sale.',
      ...REDLOOK_BRAND_COPY,
    },
  });

  console.log(`✓ Seeded ${CATEGORIES.length} categories, ${PRODUCTS.length} products, ${COUPONS.length} coupons, 1 super-admin, 1 settings row.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
