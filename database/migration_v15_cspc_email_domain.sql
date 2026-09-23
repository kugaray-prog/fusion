-- ============================================================
-- migration_v15 — default email domain is now @my.cspc.edu.ph
-- ============================================================
-- Moves every admin account and employee still on the old @geoattend.pro
-- domain to @my.cspc.edu.ph (e.g. admin@geoattend.pro becomes
-- admin@my.cspc.edu.ph). The password stays the same.
--
-- Safe to re-run. An address is skipped if its @my.cspc.edu.ph version
-- already exists, so no duplicate-email errors.
--
-- `npm run seed` does the same thing automatically, so you only need this
-- file if you don't want to re-run the seed.
--
--   mysql -u <user> -p geoattend_pro < database/migration_v15_cspc_email_domain.sql

UPDATE admin_accounts t
LEFT JOIN admin_accounts dup
  ON dup.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@my.cspc.edu.ph')
SET t.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@my.cspc.edu.ph')
WHERE t.email LIKE '%@geoattend.pro' AND dup.id IS NULL;

UPDATE employees t
LEFT JOIN employees dup
  ON dup.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@my.cspc.edu.ph')
SET t.email = CONCAT(SUBSTRING_INDEX(t.email, '@', 1), '@my.cspc.edu.ph')
WHERE t.email LIKE '%@geoattend.pro' AND dup.id IS NULL;
