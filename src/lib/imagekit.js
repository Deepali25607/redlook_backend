// ImageKit.io client wrapper — replaces the prior Cloudinary integration.
//
// Why ImageKit: same upload-+-CDN-+-on-the-fly-transform model as
// Cloudinary, but the company is based in Bengaluru (INR billing, no FX
// fees) and the free tier (20 GB bandwidth + 20 GB storage / month) is
// comfortable for a saree/lehenga catalog.
//
// Surface contract: this module exposes the SAME `uploadBuffer()` helper
// and `imagekitConfigured` boolean that the old Cloudinary wrapper did,
// and the resolved upload result is normalised to carry Cloudinary-shaped
// fields (`secure_url`, `public_id`) alongside ImageKit's native fields.
// That means `routes/adminUploads.js` only needs an import path change —
// no response-shape changes, no DB migration, no admin UI changes.
//
// Credentials come from three env vars:
//   IMAGEKIT_PUBLIC_KEY    public_xxx (safe to ship to clients later)
//   IMAGEKIT_PRIVATE_KEY   private_xxx (server-only, used for upload auth)
//   IMAGEKIT_URL_ENDPOINT  https://ik.imagekit.io/<your_id>
// When all three are absent, the wrapper stays dormant (configured=false)
// and upload routes return 503 with a clear setup message — same UX as
// the previous "CLOUDINARY_URL not set" path.

import ImageKit from '@imagekit/nodejs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_KEY    = process.env.IMAGEKIT_PUBLIC_KEY    || '';
const PRIVATE_KEY   = process.env.IMAGEKIT_PRIVATE_KEY   || '';
const URL_ENDPOINT  = process.env.IMAGEKIT_URL_ENDPOINT  || '';

// Whether the CDN client is ready. Routes used to gate on this and return
// 503 when false; they no longer do — `uploadBuffer` transparently falls
// back to a local-disk write so the admin can use uploads out of the box.
// The boolean is still exported because callers may want to surface "using
// local storage" badges in the UI later.
export const imagekitConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY && URL_ENDPOINT);

let client = null;
if (imagekitConfigured) {
  client = new ImageKit({
    privateKey:  PRIVATE_KEY,
    publicKey:   PUBLIC_KEY,
    urlEndpoint: URL_ENDPOINT,
  });
} else {
  console.warn('[imagekit] credentials not set — uploads will be saved to ./uploads on local disk. Configure IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT to switch to the CDN.');
}

// Disk fallback root. Mirrors the path that index.js serves at /uploads.
const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

// Map our internal logical extensions to a safe filename suffix.
// ImageKit's filename rules: alphanumerics, '.', '-' only — anything
// else gets rewritten to '_'. We don't need to be clever about
// extensions because ImageKit infers MIME from the bytes anyway, but
// keeping the right suffix makes the dashboard easier to browse.
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

// Streams an in-memory Buffer to ImageKit and resolves to an object the
// caller can read as either {secure_url, public_id} (Cloudinary-shape,
// for compatibility with the existing route handlers) or as a full
// ImageKit FileUploadResponse via the spread fields. `folder` keeps
// the dashboard organised by surface (products / hero / promos /
// delivery) and is the same convention the Cloudinary wrapper used.
//
// `mimetype` is optional but lets us pick a meaningful filename suffix
// when the caller knows it (multer puts it on req.file.mimetype).
export async function uploadBuffer(buffer, { folder, mimetype, resourceType = 'image' } = {}) {
  void resourceType; // accepted for API compatibility; ImageKit auto-detects

  const ext = MIME_TO_EXT[mimetype] || 'jpg';
  // Random filename so callers don't have to worry about collisions or
  // path-traversal in user-provided names. ImageKit will also add its
  // own unique suffix when `useUniqueFileName: true` (the SDK default),
  // but a UUID up front keeps the dashboard scannable.
  const fileName = `${crypto.randomUUID()}.${ext}`;

  if (!client) {
    // Disk fallback. The folder argument is a forward-slash path like
    // "redlook/products"; we write under uploads/<folder>/<filename> and
    // return /uploads/<folder>/<filename> as secure_url. resolveImageUrl
    // on the frontend already prefixes API_HOST onto /uploads/* paths.
    const safeFolder = String(folder || 'misc').replace(/[^a-zA-Z0-9/_-]/g, '_');
    const dir = path.join(UPLOADS_ROOT, safeFolder);
    await fs.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, fileName);
    await fs.writeFile(fullPath, buffer);
    const publicUrl = `/uploads/${safeFolder}/${fileName}`;
    return {
      secure_url: publicUrl,
      public_id:  publicUrl,
      url:        publicUrl,
      filePath:   publicUrl,
    };
  }

  // Node 18+ has a global File constructor; ImageKit's Uploadable type
  // accepts a File directly. This avoids any toFile() helper import and
  // works in the Node 20 runtime we already ship.
  const file = new File([buffer], fileName, { type: mimetype || 'application/octet-stream' });

  const result = await client.files.upload({
    file,
    fileName,
    folder, // ImageKit expects a slash-prefixed path; our routes pass things like "redlook/products"
    useUniqueFileName: true,
  });

  // Normalise to Cloudinary-shaped fields so legacy route code
  // (`result.secure_url`, `result.public_id`) keeps working untouched.
  // Native ImageKit fields (`url`, `fileId`, `filePath`, ...) remain
  // accessible via spread for any future caller that wants them.
  return {
    secure_url: result.url,
    public_id:  result.fileId,
    ...result,
  };
}

export { client as imagekit };
