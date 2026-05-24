// Backend i18n helpers — locale resolution + field localization.
//
// Locale codes mirror the storefront i18n: 'en' (default), 'hi', 'bn'.
// resolveLocale(req) reads the Accept-Language header the storefront sends
// on every fetch (api.js). We deliberately don't honor the full q-weighted
// language list — first match wins, keeps semantics simple.
//
// localize(entity, field, locale) pulls a translation out of a JSON column
// shaped like:
//   { name: { hi: "ताज़ा पालक", bn: "তাজা পালং" },
//     description: { hi: "...", bn: "..." } }
// Per-field fallback: an empty/missing translation returns the canonical
// English value from `entity[field]` so a half-filled admin entry never
// renders blank.

export const SUPPORTED_LOCALES = Object.freeze(['en', 'hi', 'bn']);
export const DEFAULT_LOCALE = 'en';

export function resolveLocale(req) {
  // Accept-Language can be a single tag ("hi"), with region ("hi-IN"), or a
  // comma list. Take the FIRST entry and strip region + weight.
  const raw = (req?.headers?.['accept-language'] || '')
    .split(',')[0]                // "hi-IN;q=0.9"  → "hi-IN;q=0.9"
    .split(';')[0]                // "hi-IN;q=0.9"  → "hi-IN"
    .split('-')[0]                // "hi-IN"        → "hi"
    .trim()
    .toLowerCase();
  return SUPPORTED_LOCALES.includes(raw) ? raw : DEFAULT_LOCALE;
}

export function localize(entity, field, locale) {
  if (!entity) return undefined;
  const canonical = entity[field];
  if (locale === DEFAULT_LOCALE) return canonical;
  const translated = entity.translations?.[field]?.[locale];
  if (typeof translated === 'string' && translated.trim() !== '') return translated;
  return canonical;
}

// Helper for BusinessSettings, which stores translations on FLAT keys
// (the JSON catalog of badges/hero pills lives in separate columns; the
// translations payload uses synthetic keys like hero_<key>, badge_<key>_title).
// This isolates the lookup logic from the per-section serializers.
export function localizeSetting(settings, key, fallbackValue, locale) {
  if (locale === DEFAULT_LOCALE) return fallbackValue;
  const translated = settings?.translations?.[key]?.[locale];
  if (typeof translated === 'string' && translated.trim() !== '') return translated;
  return fallbackValue;
}
