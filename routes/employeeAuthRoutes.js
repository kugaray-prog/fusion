const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const employeeAuthController = require('../controllers/employeeAuthController');
const { requireEmployeeAuth } = require('../middleware/authMiddleware');
const { uploadRegistration } = require('../middleware/uploadMiddleware');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

router.post('/login', loginLimiter, employeeAuthController.login);
router.post('/google', loginLimiter, employeeAuthController.googleLogin);
router.get('/departments', employeeAuthController.listDepartments);
// Registration sequence: Continue with Google -> employee details -> face
// registration, all submitted together here (multipart: employee details +
// a still frame under "image"; "video" is accepted for backward
// compatibility but is optional and no longer sent by the current mobile app.
// Links/creates the employee, registers the device, and enrolls the face
// (and stores the liveness clip alongside it) in one request.
router.post(
  '/link-device',
  loginLimiter,
  uploadRegistration.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  employeeAuthController.linkDevice
);
router.get('/device-status', requireEmployeeAuth, employeeAuthController.deviceStatus);

module.exports = router;
