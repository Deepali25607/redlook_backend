-- Geofence: firm/company location + delivery radius. Lat/lng nullable so
-- existing rows aren't forced to invent a coordinate; until the admin sets
-- both, the order/address routes skip the radius check. Default radius
-- 9 km per BRD.
ALTER TABLE "BusinessSettings"
  ADD COLUMN "firm_latitude"      DECIMAL(10, 7),
  ADD COLUMN "firm_longitude"     DECIMAL(10, 7),
  ADD COLUMN "delivery_radius_km" DECIMAL(8, 2) NOT NULL DEFAULT 9;
