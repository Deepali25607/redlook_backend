// Delivery geofence: firm location + radius enforcement.
//
// Two responsibilities:
//   1. Geocode a saved address into lat/lng via OpenStreetMap Nominatim
//      (free, no API key). Falls back to a pincode-only lookup if the
//      full street query misses. Returns null if both attempts fail —
//      callers decide whether that's a hard rejection or a soft skip.
//   2. Compute great-circle distance (Haversine) between two lat/lng
//      pairs in km.
//
// The radius check itself lives in the calling routes (POST /addresses,
// POST /orders) so each can format its own user-facing error.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT
  || 'Redlook/1.0 (support@redlook.local)';
// Nominatim asks for ≤1 req/sec; checkout-time geocoding is rare so we
// don't queue, we just abort fast on slow responses.
const NOMINATIM_TIMEOUT_MS = 4000;

function buildAddressQuery(addr) {
  return [addr.address_line1, addr.address_line2, addr.landmark, addr.city, addr.state, addr.pincode, 'India']
    .filter(Boolean)
    .join(', ');
}

async function nominatimSearch(query) {
  const url = `${NOMINATIM_BASE}?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=in`;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), NOMINATIM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const lat = Number(arr[0].lat);
    const lon = Number(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { latitude: lat, longitude: lon };
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Try the full address first; on miss, retry with just pincode + India so a
// vague address still gets a reasonable centroid (≈ pincode level accuracy).
export async function geocodeAddress(addr) {
  const full = await nominatimSearch(buildAddressQuery(addr));
  if (full) return full;
  if (addr.pincode) {
    return nominatimSearch(`${addr.pincode}, India`);
  }
  return null;
}

// Haversine — km between two coordinate pairs. Numeric inputs only.
const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Reads firm coords + radius off a BusinessSettings row. Returns null when
// the geofence is "not configured" (firm lat or lng missing) — callers
// treat that as "feature disabled, allow everything" so a fresh install
// doesn't block all orders before the admin has set a location.
export function getGeofence(settings) {
  if (settings?.firm_latitude == null || settings?.firm_longitude == null) return null;
  const lat = Number(settings.firm_latitude);
  const lon = Number(settings.firm_longitude);
  const radiusKm = Number(settings.delivery_radius_km ?? 9);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) return null;
  return { latitude: lat, longitude: lon, radiusKm };
}

// Decorate a serialized address with `is_deliverable` and `distance_km`.
// Decoupled from serializeAddress so it stays stateless — this one needs
// the fence (settings) which lives in the route layer.
//
//   fence === null            → feature off; treat every address as deliverable
//   address has no lat/lng    → not deliverable (geocoding never succeeded)
//   distance ≤ radius         → deliverable
//   distance > radius         → not deliverable (still saved + visible to user)
export function annotateDeliverability(address, fence) {
  if (!address) return address;
  if (!fence) return { ...address, is_deliverable: true, distance_km: null };
  const lat = address.latitude == null ? null : Number(address.latitude);
  const lon = address.longitude == null ? null : Number(address.longitude);
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ...address, is_deliverable: false, distance_km: null };
  }
  const distance = haversineKm(fence.latitude, fence.longitude, lat, lon);
  return {
    ...address,
    is_deliverable: distance <= fence.radiusKm,
    distance_km: Number(distance.toFixed(2)),
  };
}
