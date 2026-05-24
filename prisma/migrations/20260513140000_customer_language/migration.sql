-- Preferred storefront language for each customer (en / hi / bn).
-- Default 'en' so every existing row picks up English on rollout.
ALTER TABLE "Customer"
  ADD COLUMN "language" VARCHAR(5) NOT NULL DEFAULT 'en';
