const multer = require('multer');
const path = require('path');
const fs = require('fs');

function makeStorage(subfolder) {
  const dest = path.join(__dirname, '..', 'uploads', subfolder);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    }
  });
}

const imageFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
  if (ok) return cb(null, true);
  cb(new Error('Only image files (jpg, jpeg, png, webp) are allowed.'));
};

const uploadOcr = multer({
  storage: makeStorage('ocr'),
  fileFilter: imageFilter,
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB
});

const uploadPhoto = multer({
  storage: makeStorage('photos'),
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 }
});

const uploadSelfie = multer({
  storage: makeStorage('selfies'),
  fileFilter: imageFilter,
  limits: { fileSize: 6 * 1024 * 1024 }
});

const uploadFace = multer({
  storage: makeStorage('faces'),
  fileFilter: imageFilter,
  limits: { fileSize: 6 * 1024 * 1024 }
});

// Mobile device/face registration now captures a short guided liveness VIDEO
// (blink / nod / turn head left+right) in addition to the still frame used
// for the face-recognition embedding, so this needs two differently-typed
// fields ('image' + optional 'video') routed to two different folders in a
// single multipart request — hence a dedicated storage function keyed by
// fieldname rather than reusing makeStorage() above.
const REGISTRATION_FOLDERS = { image: 'faces', video: 'face_videos' };
Object.values(REGISTRATION_FOLDERS).forEach((sub) => {
  const dest = path.join(__dirname, '..', 'uploads', sub);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
});

const registrationStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', REGISTRATION_FOLDERS[file.fieldname] || 'faces')),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  }
});

const registrationFileFilter = (req, file, cb) => {
  if (file.fieldname === 'video') {
    const allowed = /mp4|mov|m4v|quicktime/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) || allowed.test(file.mimetype);
    return ok ? cb(null, true) : cb(new Error('The liveness video must be an mp4 or mov file.'));
  }
  // 'image' (and anything else) falls back to the standard photo rule.
  return imageFilter(req, file, cb);
};

// The liveness clip is only a few seconds of low-res front-camera video, but
// gets a generous ceiling since recording length/bitrate varies by device.
const uploadRegistration = multer({
  storage: registrationStorage,
  fileFilter: registrationFileFilter,
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

// Batch employee import (CSV/Excel) — kept in memory (not written to disk)
// since the file is parsed once and discarded, never served back to a browser.
const importFileFilter = (req, file, cb) => {
  const allowed = /csv|xlsx|xls/;
  const ok = allowed.test(path.extname(file.originalname).toLowerCase());
  if (ok) return cb(null, true);
  cb(new Error('Only .csv, .xlsx, or .xls files are allowed.'));
};

const uploadImportFile = multer({
  storage: multer.memoryStorage(),
  fileFilter: importFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

module.exports = { uploadOcr, uploadPhoto, uploadSelfie, uploadFace, uploadRegistration, uploadImportFile };
