const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/database');
const { generateTokens, verifyRefreshToken } = require('../utils/jwt');
const { success, error } = require('../utils/helpers');
const { auditLog } = require('../middleware/errorHandler');
const { disconnectSessionSockets } = require('../services/socketService');

// ─── Register ────────────────────────────────────────────────
const register = async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const {
      role, email, phone, password,
      full_name_ar, full_name_en, national_id,
      preferred_language = 'ar',
    } = req.body;

    if (!['customer', 'driver'].includes(role)) {
      await client.query('ROLLBACK');
      return error(res, 'Role must be customer or driver', 'INVALID_ROLE', 400);
    }

    // Check duplicates
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Email or phone already registered', 'DUPLICATE_USER', 409);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const userRes = await client.query(
      `INSERT INTO users (role, email, phone, password_hash, full_name_ar, full_name_en, national_id, preferred_language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, role, email, phone, full_name_ar, full_name_en, status, preferred_language, created_at`,
      [role, email.toLowerCase(), phone, passwordHash, full_name_ar, full_name_en || null, national_id || null, preferred_language]
    );
    const user = userRes.rows[0];

    // Create role-specific record
    if (role === 'customer') {
      await client.query('INSERT INTO customers (user_id) VALUES ($1)', [user.id]);
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);
    } else if (role === 'driver') {
      await client.query('INSERT INTO drivers (user_id) VALUES ($1)', [user.id]);
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);
    }

    // Generate tokens & session
    const { accessToken, refreshToken } = generateTokens(user);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO sessions (user_id, token, refresh_token, device_info, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, accessToken, refreshToken, JSON.stringify(req.body.device_info || {}), expiresAt]
    );

    await client.query('COMMIT');

    await auditLog(user.id, 'user_created', 'user', user.id, { role }, req);

    return success(res, {
      user: { ...user, password_hash: undefined },
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 86400,
      },
    }, 'Registration successful', 201);

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─── Login ───────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { email, phone, password, device_info } = req.body;
    const identifier = email || phone;

    const userRes = await query(
      `SELECT u.*, 
              c.tier as customer_tier,
              d.driver_status, d.availability
       FROM users u
       LEFT JOIN customers c ON c.user_id = u.id
       LEFT JOIN drivers d ON d.user_id = u.id
       WHERE (u.email = $1 OR u.phone = $1) AND u.deleted_at IS NULL`,
      [identifier?.toLowerCase() || identifier]
    );

    if (!userRes.rows.length) {
      return error(res, 'Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const user = userRes.rows[0];

    if (user.status === 'suspended') {
      return error(res, 'Account suspended. Contact support.', 'ACCOUNT_SUSPENDED', 403);
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return error(res, 'Invalid credentials', 'INVALID_CREDENTIALS', 401);
    }

    const { accessToken, refreshToken } = generateTokens(user);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO sessions (user_id, token, refresh_token, device_info, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, accessToken, refreshToken, JSON.stringify(device_info || {}), expiresAt]
    );

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    await auditLog(user.id, 'user_login', 'user', user.id, { device_info }, req);

    const { password_hash, two_fa_secret, ...safeUser } = user;

    return success(res, {
      user: safeUser,
      tokens: { access_token: accessToken, refresh_token: refreshToken, expires_in: 86400 },
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
};

// ─── Refresh Token ───────────────────────────────────────────
const refreshToken = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return error(res, 'Refresh token required', 'MISSING_TOKEN', 400);
    }

    const decoded = verifyRefreshToken(refresh_token);
    if (!decoded) {
      return error(res, 'Invalid refresh token', 'TOKEN_INVALID', 401);
    }

    const sessionRes = await query(
      `SELECT s.*, u.role, u.email, u.status FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token = $1 AND s.expires_at > NOW()`,
      [refresh_token]
    );

    if (!sessionRes.rows.length) {
      return error(res, 'Session expired', 'SESSION_EXPIRED', 401);
    }

    const session = sessionRes.rows[0];
    if (session.status !== 'active') {
      return error(res, 'Account not active', 'ACCOUNT_INACTIVE', 403);
    }

    const { accessToken, refreshToken: newRefresh } = generateTokens({
      id: session.user_id,
      role: session.role,
      email: session.email,
    });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const rotated = await query(
      `UPDATE sessions SET token=$1, refresh_token=$2, expires_at=$3, last_activity=NOW()
       WHERE id=$4 AND refresh_token=$5 AND expires_at > NOW() RETURNING id`,
      [accessToken, newRefresh, expiresAt, session.id, refresh_token]
    );
    if (!rotated.rows.length) return error(res, 'Refresh token already used or session expired', 'SESSION_EXPIRED', 401);
    disconnectSessionSockets(req.app.get('io'), session.token);

    return success(res, {
      access_token: accessToken,
      refresh_token: newRefresh,
      expires_in: 86400,
    });

  } catch (err) {
    next(err);
  }
};

// ─── Logout ──────────────────────────────────────────────────
const logout = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const revoked = await query('DELETE FROM sessions WHERE id = $1 RETURNING token', [req.session.id]);
    for (const session of revoked.rows) disconnectSessionSockets(req.app.get('io'), session.token);
    disconnectSessionSockets(req.app.get('io'), token);
    await auditLog(req.user.id, 'user_logout', 'user', req.user.id, {}, req);
    return success(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

// ─── Get Me ──────────────────────────────────────────────────
const getMe = async (req, res, next) => {
  try {
    const userRes = await query(
      `SELECT u.id, u.role, u.email, u.phone, u.full_name_ar, u.full_name_en,
              u.status, u.email_verified, u.phone_verified,
              u.two_fa_enabled, u.preferred_language, u.created_at, u.last_login,
              c.tier, c.total_orders, c.total_spent, c.saved_addresses,
              d.driver_status, d.availability, d.rating, d.total_trips, d.total_earnings, d.accepts_intercity,
              w.balance as wallet_balance
       FROM users u
       LEFT JOIN customers c ON c.user_id = u.id
       LEFT JOIN drivers d ON d.user_id = u.id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (!userRes.rows.length) {
      return error(res, 'User not found', 'NOT_FOUND', 404);
    }

    return success(res, userRes.rows[0]);
  } catch (err) {
    next(err);
  }
};

// ─── Change Password ─────────────────────────────────────────
const changePassword = async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;

    const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const isValid = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
    if (!isValid) {
      return error(res, 'Current password is incorrect', 'WRONG_PASSWORD', 400);
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);

    // Revoke all other sessions
    const revoked = await query('DELETE FROM sessions WHERE user_id = $1 AND id != $2 RETURNING token', [req.user.id, req.session.id]);
    for (const session of revoked.rows) disconnectSessionSockets(req.app.get('io'), session.token);

    await auditLog(req.user.id, 'password_change', 'user', req.user.id, {}, req);
    return success(res, null, 'Password changed successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, refreshToken, logout, getMe, changePassword };
