const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const multer = require('multer');
const { error } = require('../utils/helpers');
const { uploadRoot, resolveFilename } = require('../utils/documentStorage');

const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
const fileLimit = () => {
  const setting = process.env.MAX_FILE_SIZE ?? '5242880';
  const value = Number(setting);
  if (!/^\d+$/.test(setting) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('MAX_FILE_SIZE must be a positive integer');
  }
  return Math.min(value, 5242880);
};
const uploadFailure = message => Object.assign(new Error(message), { code: 'INVALID_FILE_TYPE' });
const cleanupUploadedFile = async req => {
  if (req.documentUploadCommitted || req.documentUploadCommitPending || req.documentUploadCleanupManaged) return;
  const name = req.file?.filename || req.documentUploadFilename;
  const filename = resolveFilename(name);
  if (filename) await fs.promises.unlink(filename).catch(err => { if (err.code !== 'ENOENT') throw err; });
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdir(uploadRoot(), { recursive: true, mode: 0o700 }, err => cb(err, uploadRoot()));
  },
  filename: (req, file, cb) => {
    if (req.aborted) return cb(Object.assign(new Error('Upload aborted'), { code: 'UPLOAD_ABORTED' }));
    const name = randomUUID() + path.extname(file.originalname).toLowerCase();
    req.documentUploadFilename = name;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: fileLimit(), files: 1, fields: 8, fieldSize: 4096, parts: 10 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!types[extension] || types[extension] !== file.mimetype) {
      return cb(uploadFailure('Only matching JPEG, PNG and PDF files are allowed'));
    }
    cb(null, true);
  },
});
const validContent = (bytes, extension) => {
  if (extension === '.png') return bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    bytes.subarray(-8, -4).toString('ascii') === 'IEND';
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (extension === '.pdf') return bytes.length >= 12 &&
    bytes.subarray(0, 5).toString('ascii') === '%PDF-' &&
    bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'));
  return false;
};
const uploadDocumentFile = (req, res, next) => {
  req.once('aborted', () => cleanupUploadedFile(req).catch(err => console.error('Aborted document cleanup failed:', err.message)));
  upload.single('file')(req, res, async err => {
    try {
      if (err) { await cleanupUploadedFile(req); return next(err); }
      if (!req.file) return error(res, 'A document file is required', 'FILE_REQUIRED', 400);
      if (req.aborted) { await cleanupUploadedFile(req); return; }
      const bytes = await fs.promises.readFile(req.file.path);
      if (!validContent(bytes, path.extname(req.file.filename).toLowerCase())) {
        await cleanupUploadedFile(req);
        return error(res, 'File content does not match a valid supported document', 'INVALID_FILE_CONTENT', 400);
      }
      await fs.promises.chmod(req.file.path, 0o600);
      next();
    } catch (failure) {
      await cleanupUploadedFile(req).catch(cleanup => console.error('Document cleanup failed:', cleanup.message));
      next(failure);
    }
  });
};

module.exports = { uploadDocumentFile, cleanupUploadedFile };
