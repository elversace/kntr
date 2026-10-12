const bcrypt = require('bcryptjs');
const { body } = require('express-validator');

function configError(message) {
  const error = new Error(message);
  error.code = 'BOOTSTRAP_CONFIG_INVALID';
  return error;
}

function buildAdminBootstrap(env = process.env) {
  for (const name of ['ADMIN_BOOTSTRAP_EMAIL', 'ADMIN_BOOTSTRAP_PHONE', 'ADMIN_BOOTSTRAP_PASSWORD', 'ADMIN_BOOTSTRAP_NAME']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw configError(`${name} is required`);
  }
  const email = env.ADMIN_BOOTSTRAP_EMAIL.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  const labels = domain?.split('.') || [];
  if (extra !== undefined || email.length > 254 || !local || local.length > 64
      || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
      || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !/^[a-z]{2,63}$/.test(labels[labels.length - 1])) {
    throw configError('ADMIN_BOOTSTRAP_EMAIL must be a valid email address');
  }
  const phone = env.ADMIN_BOOTSTRAP_PHONE.trim();
  if (!/^\+?[0-9]{8,15}$/.test(phone)) throw configError('ADMIN_BOOTSTRAP_PHONE must contain 8 to 15 digits with an optional leading +');
  const password = env.ADMIN_BOOTSTRAP_PASSWORD;
  if ([...password].length < 12 || Buffer.byteLength(password, 'utf8') > 72
      || /[\u0000-\u001f\u007f]/.test(password) || password !== password.trim()
      || !/\p{L}/u.test(password) || !/\p{N}/u.test(password) || !/[^\p{L}\p{N}\s]/u.test(password)) {
    throw configError('ADMIN_BOOTSTRAP_PASSWORD requires at least 12 characters including a letter, digit and symbol, at most 72 UTF-8 bytes, with no control or surrounding whitespace');
  }
  const fullName = env.ADMIN_BOOTSTRAP_NAME.trim();
  if (fullName.length > 255 || /[\u0000-\u001f\u007f]/.test(fullName)) throw configError('ADMIN_BOOTSTRAP_NAME must be 1 to 255 characters with no control characters');
  return { email, phone, password, fullName };
}

async function createAdmin(pool, env = process.env) {
  const values = buildAdminBootstrap(env);
  // Match the public login/register sanitizer, including Gmail alias rules.
  // A different stored spelling would make a successfully bootstrapped account
  // inaccessible through the normal API or allow a duplicate alias.
  const request = { body: { email: values.email } };
  await body('email').normalizeEmail().run(request);
  values.email = buildAdminBootstrap({ ...env, ADMIN_BOOTSTRAP_EMAIL: request.body.email }).email;
  const passwordHash = await bcrypt.hash(values.password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kntr_admin_bootstrap'))");
    const existing = await client.query('SELECT id FROM public.users WHERE lower(email) = $1 OR phone = $2', [values.email, values.phone]);
    if (existing.rows.length) {
      const error = new Error('Email or phone already exists; no account was changed or promoted');
      error.code = 'ADMIN_BOOTSTRAP_DUPLICATE';
      throw error;
    }
    const result = await client.query(`INSERT INTO public.users
      (role, email, phone, password_hash, full_name_ar, status)
      VALUES ('admin', $1, $2, $3, $4, 'active') RETURNING id, email, role`,
    [values.email, values.phone, passwordHash, values.fullName]);
    await client.query('INSERT INTO public.wallets (user_id) VALUES ($1)', [result.rows[0].id]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      const duplicate = new Error('Email or phone already exists; no account was changed or promoted');
      duplicate.code = 'ADMIN_BOOTSTRAP_DUPLICATE';
      throw duplicate;
    }
    throw error;
  } finally { client.release(); }
}

if (require.main === module) {
  require('dotenv').config();
  let pool;
  Promise.resolve().then(async () => {
    // Validate credentials before opening a database pool.
    buildAdminBootstrap();
    pool = require('../config/database').pool;
    await createAdmin(pool);
    console.log('Admin account created. Remove ADMIN_BOOTSTRAP_* variables before normal application deployment.');
  }).catch(error => {
    console.error(`Admin bootstrap failed (${error.code || 'DATABASE_ERROR'}); no existing account was changed`);
    process.exitCode = 1;
  }).finally(async () => { if (pool) await pool.end(); });
}

module.exports = { buildAdminBootstrap, createAdmin };
