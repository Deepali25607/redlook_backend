-- Admin-configurable delivery slot catalog. Default mirrors the previously
-- hardcoded list in pages.jsx so storefront behaviour is unchanged on rollout
-- and the admin can iterate without a migration.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "delivery_slots" JSONB NOT NULL DEFAULT '[
    {"id":"slot-today-4pm","day_offset":0,"start_hour":16,"end_hour":19,"label":"4 PM – 7 PM","enabled":true},
    {"id":"slot-today-7pm","day_offset":0,"start_hour":19,"end_hour":22,"label":"7 PM – 10 PM","enabled":true},
    {"id":"slot-tomorrow-7am","day_offset":1,"start_hour":7,"end_hour":10,"label":"7 AM – 10 AM","enabled":true},
    {"id":"slot-tomorrow-10am","day_offset":1,"start_hour":10,"end_hour":13,"label":"10 AM – 1 PM","enabled":true},
    {"id":"slot-tomorrow-4pm","day_offset":1,"start_hour":16,"end_hour":19,"label":"4 PM – 7 PM","enabled":true}
  ]'::jsonb;
