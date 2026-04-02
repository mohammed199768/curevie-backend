const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { AppError } = require('../middlewares/errorHandler');
// AUDIT-FIX: S2 — file-type reads binary magic bytes to detect actual file type
const FileType = require('file-type');

// AUDIT-FIX: PATH — use __dirname so uploads resolve inside backend/
// __dirname = backend/utils → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..');
const uploadsDir = path.join(BACKEND_ROOT, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const requestFileMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const extensionByMimeType = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = extensionByMimeType[file.mimetype] || 'bin';
    cb(null, `${Date.now()}-${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!requestFileMimeTypes.has(file.mimetype)) {
      return cb(new AppError('Unsupported file type', 400, 'INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

const uploadRequestFiles = (req, res, next) => {
  upload.array('files', 5)(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('Max file size is 5MB', 400, 'FILE_TOO_LARGE'));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new AppError('Maximum 5 files are allowed', 400, 'TOO_MANY_FILES'));
      }
    }

    if (err.isOperational) return next(err);
    return next(new AppError(err.message || 'File upload failed', 400, 'UPLOAD_ERROR'));
  });
};

const imageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const chatMediaMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

function createSingleUploadMiddleware({
  fieldName = 'file',
  maxSizeMB = 5,
  allowedMimeTypes = imageMimeTypes,
}) {
  const memoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (allowedMimeTypes && !allowedMimeTypes.has(file.mimetype)) {
        return cb(new AppError('Unsupported file type', 400, 'INVALID_FILE_TYPE'));
      }
      cb(null, true);
    },
  });

  return (req, res, next) => {
    memoryUpload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(`Max file size is ${maxSizeMB}MB`, 400, 'FILE_TOO_LARGE'));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(new AppError('Only one file is allowed', 400, 'TOO_MANY_FILES'));
        }
      }

      if (err.isOperational) return next(err);
      return next(new AppError(err.message || 'File upload failed', 400, 'UPLOAD_ERROR'));
    });
  };
}

const uploadSingleImage = createSingleUploadMiddleware({
  fieldName: 'file',
  maxSizeMB: 5,
  allowedMimeTypes: imageMimeTypes,
});

const uploadSingleChatMedia = createSingleUploadMiddleware({
  fieldName: 'file',
  maxSizeMB: 50,
  allowedMimeTypes: chatMediaMimeTypes,
});

const uploadSinglePdf = createSingleUploadMiddleware({
  fieldName: 'file',
  maxSizeMB: 20,
  allowedMimeTypes: new Set(['application/pdf']),
});

// AUDIT-FIX: S2 — allowed real MIME types for image uploads (magic bytes)
const allowedImageMagicBytes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const allowedChatMediaMagicBytes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
// AUDIT-FIX: S2 — allowed real MIME types for PDF uploads (magic bytes)
const allowedPdfMagicBytes = new Set(['application/pdf']);
// AUDIT-FIX: S2 — combined set for request file uploads (images + PDF)
const allowedRequestFileMagicBytes = new Set([...allowedImageMagicBytes, 'application/pdf']);

// AUDIT-FIX: S2 — validate actual file contents via magic bytes (memoryStorage)
// file.mimetype is user-controlled (HTTP header) and can be spoofed
// fileTypeFromBuffer reads the actual binary signature
function createBufferValidator(allowedMimes) {
  return async function validateFileBuffer(req, res, next) {
    // AUDIT-FIX: S2 — skip validation if no file was uploaded
    if (!req.file && !req.files) return next();

    try {
      const filesToCheck = req.files || (req.file ? [req.file] : []);
      for (const file of filesToCheck) {
        const source = file.buffer || (file.path ? fs.readFileSync(file.path) : null);
        if (!source) continue;

        // AUDIT-FIX: S2 — read magic bytes from actual file buffer
        const detected = await FileType.fromBuffer(source);

        // AUDIT-FIX: S2 — if file-type cannot detect, it may be a text file
        // (scripts, HTML) — these are never valid uploads
        if (!detected) {
          // AUDIT-FIX: S2 — delete disk file if it was already saved
          if (file.path) fs.unlink(file.path, () => {});
          return next(new AppError(
            'File type could not be verified',
            400,
            'INVALID_FILE_CONTENTS'
          ));
        }

        // AUDIT-FIX: S2 — check detected MIME against allowed list,
        // NOT the user-supplied header
        if (!allowedMimes.has(detected.mime)) {
          if (file.path) fs.unlink(file.path, () => {});
          return next(new AppError(
            `File contains ${detected.mime} data which is not allowed`,
            400,
            'INVALID_FILE_CONTENTS'
          ));
        }

        // AUDIT-FIX: S2 — overwrite the user-supplied mimetype with
        // the verified one so downstream code can trust it
        file.mimetype = detected.mime;
        file.detectedExt = detected.ext;
      }

      next();
    } catch (err) {
      next(new AppError('File validation failed', 500, 'FILE_VALIDATION_ERROR'));
    }
  };
}

// AUDIT-FIX: S2 — magic bytes validator for image-only routes
const validateImageContents = createBufferValidator(allowedImageMagicBytes);
const validateChatMediaContents = createBufferValidator(allowedChatMediaMagicBytes);
// AUDIT-FIX: S2 — magic bytes validator for PDF-only routes
const validatePdfContents = createBufferValidator(allowedPdfMagicBytes);
// AUDIT-FIX: S2 — magic bytes validator for request files (images + PDF)
const validateRequestFileContents = createBufferValidator(allowedRequestFileMagicBytes);

module.exports = {
  uploadRequestFiles,
  uploadSingleImage,
  uploadSingleChatMedia,
  uploadSinglePdf,
  validateImageContents,
  validateChatMediaContents,
  validatePdfContents,
  validateRequestFileContents,
};
