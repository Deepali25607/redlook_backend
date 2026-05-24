// Admin upload endpoints — product images (gated on 'products'),
// home-hero background images (gated on 'settings'), promo-banner
// images (gated on 'settings'), and rider open-box delivery photos
// (gated on 'orders'). Mounted at /api/admin/uploads.
//
// Storage strategy: ImageKit.io (CDN). Files are received into memory
// by multer (memoryStorage), then streamed to ImageKit via the SDK.
// The returned `secure_url` is what gets stored on the relevant model.
//
// Why ImageKit (and not on-disk): Render's free-tier disk is ephemeral
// — every redeploy wipes /uploads, so any URL captured before the
// deploy silently breaks. ImageKit's free tier (20 GB bandwidth + 20
// GB storage / month) survives every redeploy and bills in INR, so
// it pairs cleanly with the Razorpay-flavoured rest of the stack.
// The route response shape (`{ data: { url, size, mimetype } }`) is
// unchanged so nothing on the client needs to migrate; resolveImageUrl
// on the frontend already passes absolute https URLs through as-is.

import { Router } from 'express';
import multer from 'multer';
import { requirePermission } from '../middleware/adminAuth.js';
import { badRequest } from '../lib/http.js';
import { uploadBuffer } from '../lib/imagekit.js';

const router = Router();

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PRODUCT_MAX_BYTES = 5 * 1024 * 1024;
const HERO_MAX_BYTES    = 8 * 1024 * 1024;
// Open-box delivery photos come from a rider's phone — usually 2–4 MB JPEGs
// straight from the camera. 10 MB so the default camera quality isn't rejected.
const DELIVERY_MAX_BYTES = 10 * 1024 * 1024;
// Promotion banners are hero-style images; matches the home-hero cap.
const PROMO_MAX_BYTES = 8 * 1024 * 1024;

// One multer instance per route limit. memoryStorage keeps the file in
// req.file.buffer so it can be streamed straight to ImageKit without
// ever touching the local disk — which is the whole point.
function makeUploader(maxBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        const e = new Error('Only JPEG, PNG, WEBP, or GIF images are allowed.');
        e.status = 400;
        return cb(e, false);
      }
      cb(null, true);
    },
  });
}

const productUpload  = makeUploader(PRODUCT_MAX_BYTES);
const heroUpload     = makeUploader(HERO_MAX_BYTES);
const deliveryUpload = makeUploader(DELIVERY_MAX_BYTES);
const promoUpload    = makeUploader(PROMO_MAX_BYTES);

// Wraps multer's middleware so file-size / file-type rejections surface as
// a clean 400 instead of an unhandled error.
function runMulter(uploader, fieldName, maxBytes) {
  return (req, res, next) => {
    uploader.single(fieldName)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Max ${Math.round(maxBytes / 1024 / 1024)} MB.` });
      }
      return res.status(err.status || 400).json({ error: err.message || 'Upload failed' });
    });
  };
}

// Shared upload handler: validates the request, pipes the buffer to
// ImageKit, and returns a route-shape response. `folder` keeps the
// library organised in the ImageKit dashboard.
async function handleUpload(req, res, folder) {
  // When ImageKit isn't configured, uploadBuffer transparently falls back
  // to local-disk storage (under ./uploads, served by index.js at /uploads).
  // We no longer 503 here — the admin gets a working upload either way.
  if (!req.file) badRequest('No image file received. Use form field "image".');
  try {
    const result = await uploadBuffer(req.file.buffer, { folder, mimetype: req.file.mimetype });
    res.status(201).json({
      data: {
        url: result.secure_url,
        size: req.file.size,
        mimetype: req.file.mimetype,
        // Public id is handy if we ever want to delete the asset later
        // (eg. when the admin removes a promo or product image). With
        // ImageKit this is the `fileId` exposed via Cloudinary-shaped
        // alias by the wrapper.
        public_id: result.public_id,
      },
    });
  } catch (err) {
    console.error('[uploads] ImageKit upload failed:', err?.message || err);
    res.status(502).json({ error: 'Image upload failed. Please retry.' });
  }
}

// POST /api/admin/uploads/product-image
// Form field: image (single file). Permission: 'products'.
// Response: { data: { url: '<imagekit absolute url>', ... } }
// Caller stores `data.url` in Product.image.
router.post('/product-image',
  requirePermission('products'),
  runMulter(productUpload, 'image', PRODUCT_MAX_BYTES),
  (req, res) => handleUpload(req, res, 'redlook/products'));

// POST /api/admin/uploads/hero-image
// Form field: image (single file). Permission: 'settings'.
// Caller writes `data.url` into home_hero_features.background_image.title.
router.post('/hero-image',
  requirePermission('settings'),
  runMulter(heroUpload, 'image', HERO_MAX_BYTES),
  (req, res) => handleUpload(req, res, 'redlook/hero'));

// POST /api/admin/uploads/promo-image
// Form field: image (single file). Permission: 'settings'.
// Caller writes `data.url` into BusinessSettings.category_promotions[i].image_url.
router.post('/promo-image',
  requirePermission('settings'),
  runMulter(promoUpload, 'image', PROMO_MAX_BYTES),
  (req, res) => handleUpload(req, res, 'redlook/promos'));

// POST /api/admin/uploads/delivery-photo
// Form field: image (single file). Permission: 'orders'.
// Caller stages the returned URL in component state and includes the array
// on the PUT /:id/status payload so photos are committed atomically with
// the Delivered transition (no orphan uploads if the rider abandons).
router.post('/delivery-photo',
  requirePermission('orders'),
  runMulter(deliveryUpload, 'image', DELIVERY_MAX_BYTES),
  (req, res) => handleUpload(req, res, 'redlook/delivery'));

export default router;
