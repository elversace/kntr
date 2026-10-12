const { verifyToken } = require('../utils/jwt');
const { query } = require('../config/database');
const { error } = require('../utils/helpers');

// ─── Authenticate ────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Authorization token required', 'UNAUTHORIZED', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) {
      return error(res, 'Invalid or expired token', 'TOKEN_INVALID', 401);
    }

    // Check session still valid
    const sessionRes = await query(
      `SELECT s.*, u.status, u.role, u.email, u.deleted_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (!sessionRes.rows.length) {
      return error(res, 'Session expired or revoked', 'SESSION_EXPIRED', 401);
    }

    const session = sessionRes.rows[0];
    if (decoded.id !== session.user_id) {
      return error(res, 'Invalid session identity', 'TOKEN_INVALID', 401);
    }
    if (session.status === 'suspended') {
      return error(res, 'Account suspended', 'ACCOUNT_SUSPENDED', 403);
    }
    if (session.status === 'deleted' || session.deleted_at) {
      return error(res, 'Account not found', 'ACCOUNT_DELETED', 403);
    }
    if (session.status !== 'active') {
      return error(res, 'Account not active', 'ACCOUNT_INACTIVE', 403);
    }

    // Update last activity
    await query('UPDATE sessions SET last_activity = NOW() WHERE id = $1', [session.id]);

    // Authoritative permissions come from the database, not stale token claims.
    req.user = { id: session.user_id, role: session.role, email: session.email };
    req.session = session;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return error(res, 'Authentication failed', 'AUTH_ERROR', 500);
  }
};

// ─── Role Guards ─────────────────────────────────────────────
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return error(res, 'Insufficient permissions', 'FORBIDDEN', 403);
    }
    next();
  };
};

const isAdmin    = authorize('admin');
const isDriver   = authorize('driver');
const isCustomer = authorize('customer');
const isSupport  = authorize('admin', 'support');
const isFinance  = authorize('admin', 'finance');
const isAudit    = authorize('admin', 'audit');

const isApprovedDriver = async (req, res, next) => {
  try {
    if (req.user?.role !== 'driver') return error(res, 'Driver account required', 'FORBIDDEN', 403);
    const result = await query('SELECT driver_status FROM drivers WHERE user_id = $1', [req.user.id]);
    if (result.rows[0]?.driver_status !== 'approved') {
      return error(res, 'Driver not approved', 'NOT_APPROVED', 403);
    }
    next();
  } catch (err) { next(err); }
};

// ─── Optional Auth (for public + auth routes) ────────────────
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    req.user = null;
    if (decoded) {
      const result = await query(
        `SELECT s.user_id, u.role, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > NOW() AND u.status = 'active' AND u.deleted_at IS NULL`,
        [token]
      );
      const session = result.rows[0];
      if (session && decoded.id === session.user_id) {
        req.user = { id: session.user_id, role: session.role, email: session.email };
      }
    }
    next();
  } catch {
    req.user = null;
    next();
  }
};

module.exports = { authenticate, authorize, isAdmin, isDriver, isApprovedDriver, isCustomer, isSupport, isFinance, isAudit, optionalAuth };
