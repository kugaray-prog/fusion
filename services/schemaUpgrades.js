const pool = require('../config/db');

// Small, idempotent schema changes applied at server start, so an existing
// database (e.g. the live Aiven one) picks them up without a manual
// migration. Each step checks before changing anything.

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

// employees.is_approved: 0 for someone who registered themselves in the app
// and hasn't been accepted by an admin yet (their device is still pending).
// They stay out of the Employees list, dashboard counts, ratings and reports
// until an admin approves their device (deviceController.updateDeviceStatus).
// Everyone already in the database counts as approved, except earlier
// self-registrations whose device was never approved.
async function addEmployeeApproval() {
  if (await columnExists('employees', 'is_approved')) return;
  await pool.query('ALTER TABLE employees ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 1');
  const [result] = await pool.query(
    `UPDATE employees e SET e.is_approved = 0
     WHERE e.employee_code IN (
       SELECT JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.employeeCode')) FROM audit_logs a
       WHERE a.action = 'self_register' AND JSON_VALID(a.details)
     )
     AND NOT EXISTS (SELECT 1 FROM mobile_devices md WHERE md.employee_id = e.id AND md.status = 'approved')`
  );
  console.log(`[schema] Added employees.is_approved (${result.affectedRows} pending self-registration(s)).`);
}

async function run() {
  await addEmployeeApproval();
}

module.exports = { run };
