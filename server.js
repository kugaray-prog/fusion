require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const config = require('./config/config');

// ------------------------------------------------------------
// Safety nets
// ------------------------------------------------------------
// Prevent unexpected async errors from crashing the whole server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ------------------------------------------------------------
// App configuration
// ------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log(`Environment: ${NODE_ENV}`);

// ------------------------------------------------------------
// Security & Core Middleware
// ------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ------------------------------------------------------------
// Session
// ------------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_session_secret',

    resave: false,

    saveUninitialized: false,

    cookie: {
      secure: NODE_ENV === 'production',
      httpOnly: true,
      sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

// ------------------------------------------------------------
// API Rate Limiting
// ------------------------------------------------------------
// During local development, rate limiting is disabled so repeated
// login/testing requests will not be blocked.
//
// In production, the API is protected with a rate limiter.
//
// IMPORTANT:
// This is only the GLOBAL /api limiter.
// If login still says "Too many login attempts", there is
// another login-specific limiter inside authRoutes.js or
// employeeAuthRoutes.js.
// ------------------------------------------------------------

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  // Production limit
  max: 1000,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: 'Too many requests. Please try again later.'
  }
});

// Apply the global API limiter ONLY in production.
if (NODE_ENV === 'production') {
  app.use('/api', apiLimiter);

  console.log('API rate limiting: ENABLED');
} else {
  console.log('API rate limiting: DISABLED (development mode)');
}

// ------------------------------------------------------------
// Static Assets & Uploaded Files
// ------------------------------------------------------------

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

app.use(
  '/public',
  express.static(path.join(__dirname, 'public'))
);

app.use(
  express.static(path.join(__dirname, 'public'))
);

// ------------------------------------------------------------
// View Engine
// ------------------------------------------------------------

app.set('view engine', 'ejs');

app.set(
  'views',
  path.join(__dirname, 'views')
);

// ------------------------------------------------------------
// API Routes
// ------------------------------------------------------------

// Admin authentication
app.use(
  '/api/auth',
  require('./routes/authRoutes')
);

// Employee / mobile authentication
app.use(
  '/api/employee-auth',
  require('./routes/employeeAuthRoutes')
);

// Employees
app.use(
  '/api/employees',
  require('./routes/employeeRoutes')
);

// Departments
app.use(
  '/api/departments',
  require('./routes/departmentRoutes')
);

// Attendance
app.use(
  '/api/attendance',
  require('./routes/attendanceRoutes')
);

// Geo-fences
app.use(
  '/api/geofences',
  require('./routes/geofenceRoutes')
);

// Events
app.use(
  '/api/events',
  require('./routes/eventRoutes')
);

// OCR
app.use(
  '/api/ocr',
  require('./routes/ocrRoutes')
);

// Face verification
app.use(
  '/api/face',
  require('./routes/faceRoutes')
);

// Device management
app.use(
  '/api/devices',
  require('./routes/deviceRoutes')
);

// Reports
app.use(
  '/api/reports',
  require('./routes/reportRoutes')
);

// Certificates
app.use(
  '/api/certificates',
  require('./routes/certificateRoutes')
);

// Dashboard
app.use(
  '/api/dashboard',
  require('./routes/dashboardRoutes')
);

// Ratings
app.use(
  '/api/ratings',
  require('./routes/ratingRoutes')
);

// Admin accounts
app.use(
  '/api/admin-accounts',
  require('./routes/adminAccountRoutes')
);

// ------------------------------------------------------------
// API Health Check
// ------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'GeoAttend Pro API is running.',
    environment: NODE_ENV
  });
});

// ------------------------------------------------------------
// Admin Dashboard
// ------------------------------------------------------------

app.get('/', (req, res) => {
  res.render('dashboard', {
    googleMapsApiKey:
      process.env.GOOGLE_MAPS_API_KEY || '',

    // Pre-fills the admin login field (admin@my.cspc.edu.ph by default)
    defaultAdminEmail: config.email.defaultAdmin
  });
});

// ------------------------------------------------------------
// Mobile Page
// ------------------------------------------------------------

app.get('/mobile', (req, res) => {
  res.render('mobile', {
    googleClientId:
      process.env.GOOGLE_CLIENT_ID || ''
  });
});

// ------------------------------------------------------------
// Error Handling
// ------------------------------------------------------------

app.use(notFound);

app.use(errorHandler);

// ------------------------------------------------------------
// Start Server
// ------------------------------------------------------------

app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('       GeoAttend Pro Server');
  console.log('==========================================');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(
    `API: http://localhost:${PORT}/api/health`
  );
  console.log('==========================================');
  console.log('');
}); 