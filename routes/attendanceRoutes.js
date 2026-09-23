const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { requireAuth, requireEmployeeAuth, requireRole } = require('../middleware/authMiddleware');
const { uploadSelfie } = require('../middleware/uploadMiddleware');

router.post('/submit', attendanceController.submitAttendance);
router.get('/my-history', requireEmployeeAuth, attendanceController.getMyHistory);
router.get('/:id/sessions', requireEmployeeAuth, attendanceController.getSessions);router.post('/:id/face-verify', requireEmployeeAuth, uploadSelfie.single('selfie'), attendanceController.faceVerify);
router.post('/:id/heartbeat', requireEmployeeAuth, attendanceController.heartbeat);

router.get('/', requireAuth, requireRole('super_admin'), attendanceController.getAttendance);
router.get('/by-department', requireAuth, requireRole('super_admin'), attendanceController.getAttendanceByDepartment);
router.get('/by-event', requireAuth, requireRole('super_admin'), attendanceController.getAttendanceByEvent);
router.get('/anomalies', requireAuth, requireRole('super_admin'), attendanceController.getAnomalies);
router.patch('/anomalies/:id/resolve', requireAuth, requireRole('super_admin'), attendanceController.resolveAnomaly);
router.get('/:id/sessions/admin', requireAuth, requireRole('super_admin'), attendanceController.getSessionsAdmin);
router.patch('/:id', requireAuth, requireRole('super_admin'), attendanceController.updateAttendance);
router.delete('/:id', requireAuth, requireRole('super_admin'), attendanceController.deleteAttendance);

module.exports = router;
