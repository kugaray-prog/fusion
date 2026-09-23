-- ============================================================
-- migration_v16 — Mobile Device Registration: Position and Gender become
-- dropdowns (with a free-text "Others" option), and Classification gets a
-- new fixed option list, also with "Others".
-- ============================================================
-- 1. Adds employees.gender (new field, collected starting from the mobile
--    registration form; nullable since no existing employee record has one
--    on file yet).
-- 2. Widens employees.classification from ENUM('Regular','COS','Casual') to
--    VARCHAR(50). An ENUM can only ever hold one of its declared values, so
--    it can't represent the new Classification options (Permanent
--    Administrative, Permanent Academic, Casual Administrative, COS
--    Administrative, COS Academic, Job Order) or anything typed into the
--    new "Others" free-text override. Every existing 'Regular' / 'COS' /
--    'Casual' value is preserved exactly as-is by this ALTER — nothing is
--    renamed or reset.
--
-- Safe to re-run: the ADD COLUMN below is guarded with a dynamic-SQL check
-- against information_schema (plain `ADD COLUMN IF NOT EXISTS` isn't
-- accepted by every MySQL 8 build/sql_mode, so this more portable pattern
-- is used instead). MODIFY COLUMN is naturally idempotent -- re-applying the
-- same column definition on a second run is a no-op.
--
--   mysql -u <user> -p geoattend_pro < database/migration_v16_position_gender_classification.sql

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'gender'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE employees ADD COLUMN gender VARCHAR(40) NULL AFTER position',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE employees
  MODIFY COLUMN classification VARCHAR(50) DEFAULT 'Regular';
