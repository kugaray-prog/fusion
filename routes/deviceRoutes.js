const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.post('/register', deviceController.registerDevice);
router.get('/', requireAuth, requireRole('super_admin'), deviceController.getDevices);
router.patch('/:id/status', requireAuth, requireRole('super_admin'), deviceController.updateDeviceStatus);

module.exports = router;
