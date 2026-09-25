const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const { requireAuth, requireRole, requireEmployeeAuth } = require('../middleware/authMiddleware');

// Signed-in employees only: a deleted or blocked device is refused by
// requireEmployeeAuth instead of being silently re-created here.
router.post('/register', requireEmployeeAuth, deviceController.registerDevice);
router.get('/', requireAuth, requireRole('super_admin'), deviceController.getDevices);
router.patch('/:id/status', requireAuth, requireRole('super_admin'), deviceController.updateDeviceStatus);
router.delete('/:id', requireAuth, requireRole('super_admin'), deviceController.deleteDevice);

module.exports = router;
