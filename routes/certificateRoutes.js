const express = require('express');
const router = express.Router();
const certificateController = require('../controllers/certificateController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

router.use(requireAuth, requireRole('super_admin'));
router.post('/generate', certificateController.generateCertificate);
router.get('/', certificateController.getCertificates);

module.exports = router;
