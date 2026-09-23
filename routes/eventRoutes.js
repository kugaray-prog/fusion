const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');

// Both super_admin and the restricted Verification-only 'admin' role can
// read the ongoing-events list, for the OCR/Face Verification panels' event
// picker (see ocrRoutes.js / faceRoutes.js for the matching scoped access on
// /api/ocr/verify and /api/face/verify). Must be registered before the
// router.use(...) below, which locks everything else to super_admin only.
router.get('/ongoing', requireAuth, requireRole('super_admin', 'admin'), eventController.getOngoingEvents);

router.use(requireAuth, requireRole('super_admin'));
router.get('/', eventController.getAllEvents);
router.get('/:id/occurrences', eventController.getOccurrences);

module.exports = router;
