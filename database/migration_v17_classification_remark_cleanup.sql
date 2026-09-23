-- ============================================================
-- migration_v17 — Employees: drop the Legacy Classification options,
-- and Remark is now only Active / On Leave.
-- ============================================================
-- Classification: the admin Employees form's dropdown no longer offers the
-- old Regular/COS/Casual values (only the six from
-- migration_v16_position_gender_classification.sql, plus Others). Any
-- employee still on one of those old values is reassigned here first, so
-- nobody is left on a classification the dropdown can no longer show:
--   'Casual'  -> 'Casual Administrative'  (the only Casual option there is)
--   'COS'     -> 'COS Academic' if their Position looks like an academic
--                title (Instructor/Professor/Dean/Chair/Faculty),
--                otherwise 'COS Administrative'
--   'Regular' -> 'Permanent Academic' or 'Permanent Administrative', by the
--                same Position-based rule
-- The Academic/Administrative split is a best-effort guess from Position
-- text, not a guarantee -- spot-check the results (the query below the
-- UPDATEs lists everyone this migration touched) and correct any that
-- guessed wrong from the Employees tab as you would any other edit.
--
-- Remark: was Active/Inactive/Leave; is now just Active/On Leave (an
-- employee no longer with the institution should be reflected in their
-- employment Status field, e.g. set to Inactive there, rather than in this
-- day-to-day attendance-relevant flag). Existing 'Inactive' and 'Leave'
-- remarks both become 'On Leave' -- this doesn't change any
-- attendance-expectation logic anywhere in the app, since every place that
-- reads this column already only ever checks `remark = 'Active'` and
-- treats anything else as "not currently expected to attend"; only the
-- label changes for the non-Active case.
--
-- Safe to re-run: the classification UPDATEs only match the exact old
-- values, so they're no-ops once those values are gone; the remark ALTER
-- re-applies the same definition on a second run.
--
--   mysql -u <user> -p geoattend_pro < database/migration_v17_classification_remark_cleanup.sql

UPDATE employees SET classification = 'Casual Administrative' WHERE classification = 'Casual';

UPDATE employees
SET classification = IF(
  position REGEXP 'Instructor|Professor|Dean|Chair|Faculty',
  'COS Academic', 'COS Administrative'
)
WHERE classification = 'COS';

UPDATE employees
SET classification = IF(
  position REGEXP 'Instructor|Professor|Dean|Chair|Faculty',
  'Permanent Academic', 'Permanent Administrative'
)
WHERE classification = 'Regular';

-- The column's own DEFAULT (used when a row is inserted without specifying
-- classification at all) was 'Regular' too -- update it to a value that's
-- actually still selectable, for the same reason as the values above.
ALTER TABLE employees
  MODIFY COLUMN classification VARCHAR(50) DEFAULT 'Permanent Administrative';

-- The UPDATE below sets remark to 'On Leave', a value the column's current
-- ENUM('Active','Inactive','Leave') doesn't accept yet -- widen it first so
-- the UPDATE can succeed, then narrow it to the final two values once every
-- row has been reassigned.
ALTER TABLE employees
  MODIFY COLUMN remark ENUM('Active','Inactive','Leave','On Leave') DEFAULT 'Active';

UPDATE employees SET remark = 'On Leave' WHERE remark IN ('Inactive', 'Leave');

ALTER TABLE employees
  MODIFY COLUMN remark ENUM('Active','On Leave') DEFAULT 'Active';

-- Review list: everyone currently on a Position-guessed classification
-- (COS Academic/Administrative or Permanent Academic/Administrative --
-- Casual Administrative isn't included since that mapping is unambiguous).
-- Includes anyone already on one of these values before this migration
-- too, not only rows it just changed -- there's no way to tell those apart
-- after the fact, so treat this as "these are worth a spot-check", not
-- "these are exactly what changed just now".
SELECT employee_code, full_name, position, classification AS current_classification
FROM employees
WHERE classification IN ('COS Academic', 'COS Administrative', 'Permanent Academic', 'Permanent Administrative')
ORDER BY classification, full_name;
