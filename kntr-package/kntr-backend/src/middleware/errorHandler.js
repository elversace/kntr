const { error } = require('../utils/helpers');
const { cleanupUploadedFile } = require('./documentUpload');

// ─── Global Error Handler ────────────────────────────────────
const errorHandler = async (err, req, res, next) => {
  if (res.headersSent) return next(err);
  await cleanupUploadedFile(req).catch(cleanup => console.error('Document cleanup failed:', cleanup.message));
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  if (process.env.NODE_ENV === 'development') console.error(err.stack);

  // Postgres errors
  if (err.code === '23505') {
    const field = err.detail?.match(/\((.+?)\)/)?.[1] || 'field';
    return error(res, `${field} already exists`, 'DUPLICATE_ENTRY', 409);
  }
  if (err.code === '23503') {
    return error(res, 'Related record not found', 'FOREIGN_KEY_ERROR', 400);
  }
  if (err.code === '22P02') {
    return error(res, 'Invalid UUID format', 'INVALID_UUID', 400);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return error(res, 'Invalid token', 'TOKEN_INVALID', 401);
  }
  if (err.name === 'TokenExpiredError') {
    return error(res, 'Token expired', 'TOKEN_EXPIRED', 401);
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return error(res, 'File too large (max 5MB)', 'FILE_TOO_LARGE', 400);
  }
  if (err.code === 'INVALID_FILE_TYPE' || err.code === 'UPLOAD_ABORTED' || err.code?.startsWith('LIMIT_')) {
    return error(res, err.message, err.code === 'INVALID_FILE_TYPE' ? err.code : 'INVALID_UPLOAD', 400);
  }

  return error(res, 'Internal server error', 'SERVER_ERROR', 500);
};

// ─── 404 Handler ─────────────────────────────────────────────
const notFound = (req, res) => {
  error(res, `Route ${req.method} ${req.path} not found`, 'NOT_FOUND', 404);
};

// ─── Audit Logger ─────────────────────────────────────────────
const { query } = require('../config/database');

const auditLog = async (userId, action, targetType, targetId, details, req) => {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId || null,
        action,
        targetType || null,
        targetId ? String(targetId) : null,
        details ? JSON.stringify(details) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
      ]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
};

module.exports = { errorHandler, notFound, auditLog };
