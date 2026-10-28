const multer = require('multer');
const FileType = require('file-type');
const { AppError } = require('../middlewares/errorHandler');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const CASE_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const CHAT_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'video/mp4', 'video/quicktime', 'video/webm',
]);

/**
 * Single-file upload kept in memory, then verified by magic bytes: the client-supplied
 * Content-Type is only a first filter and is replaced by the detected type.
 */
function createSingleUpload({ fieldName = 'file', maxSizeMB, allowedTypes }) {
  const memoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!allowedTypes.has(file.mimetype)) {
        return cb(new AppError('Unsupported file type', 400, 'INVALID_FILE_TYPE'));
      }
      return cb(null, true);
    },
  }).single(fieldName);

  const receive = (req, res, next) => memoryUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(`Max file size is ${maxSizeMB}MB`, 400, 'FILE_TOO_LARGE'));
      }
      return next(new AppError('Only one file is allowed', 400, 'TOO_MANY_FILES'));
    }
    if (err.isOperational) return next(err);
    return next(new AppError('File upload failed', 400, 'UPLOAD_ERROR'));
  });

  const verify = async (req, res, next) => {
    if (!req.file) return next();
    try {
      const detected = await FileType.fromBuffer(req.file.buffer);
      if (!detected || !allowedTypes.has(detected.mime)) {
        return next(new AppError('File contents do not match an allowed type', 400, 'INVALID_FILE_CONTENTS'));
      }
      req.file.mimetype = detected.mime;
      req.file.detectedExt = detected.ext;
      return next();
    } catch (_) {
      return next(new AppError('File validation failed', 400, 'FILE_VALIDATION_ERROR'));
    }
  };

  return [receive, verify];
}

const uploadImage = createSingleUpload({ maxSizeMB: 5, allowedTypes: IMAGE_TYPES });
const uploadCaseFile = createSingleUpload({ maxSizeMB: 20, allowedTypes: CASE_FILE_TYPES });
const uploadChatMedia = createSingleUpload({ maxSizeMB: 25, allowedTypes: CHAT_MEDIA_TYPES });

module.exports = {
  uploadImage,
  uploadCaseFile,
  uploadChatMedia,
};
