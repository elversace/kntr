const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function integerSetting(value, fallback, min, max, name) {
  const text = value === undefined ? String(fallback) : String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function parseOrigins(value, production) {
  if (!value?.trim()) {
    if (production) throw new Error('ALLOWED_ORIGINS is required in production');
    return ['*'];
  }
  const values = value.split(',').map(item => item.trim());
  if (values.some(item => !item)) throw new Error('ALLOWED_ORIGINS contains an empty origin');
  if (values.includes('*')) {
    if (production || values.length !== 1) throw new Error('Wildcard ALLOWED_ORIGINS is only allowed alone outside production');
    return ['*'];
  }
  return [...new Set(values.map(value => {
    let origin;
    try { origin = new URL(value); } catch { throw new Error('ALLOWED_ORIGINS contains an invalid origin'); }
    if (!['https:', 'http:', 'capacitor:'].includes(origin.protocol) || !origin.hostname ||
        origin.username || origin.password || origin.search || origin.hash ||
        (origin.pathname && origin.pathname !== '/')) {
      throw new Error('ALLOWED_ORIGINS must contain origins without paths or credentials');
    }
    if (origin.protocol === 'capacitor:' && origin.host !== 'localhost') {
      throw new Error('The supported Capacitor origin is capacitor://localhost');
    }
    if (production && origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
      throw new Error('Production web origins must use HTTPS');
    }
    return `${origin.protocol}//${origin.host}`;
  }))];
}

function loadRuntimeConfig(env = process.env) {
  const mode = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('NODE_ENV must be development, test or production');
  const production = mode === 'production';
  if (!env.JWT_SECRET || !env.JWT_REFRESH_SECRET) throw new Error('JWT_SECRET and JWT_REFRESH_SECRET are required');
  if (production && (env.JWT_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32 || env.JWT_SECRET === env.JWT_REFRESH_SECRET)) {
    throw new Error('Production requires two independent JWT secrets of at least 32 characters');
  }
  if (production && (!env.UPLOAD_PATH || !path.isAbsolute(env.UPLOAD_PATH))) {
    throw new Error('UPLOAD_PATH must be an absolute private persistent directory in production');
  }
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS, production);
  return {
    mode, production,
    port: integerSetting(env.PORT, 3000, 1, 65535, 'PORT'),
    trustProxy: integerSetting(env.TRUST_PROXY, 0, 0, 10, 'TRUST_PROXY'),
    allowedOrigins,
    wildcardOrigins: allowedOrigins[0] === '*',
    uploadPath: path.resolve(env.UPLOAD_PATH || path.join(__dirname, '../../uploads')),
  };
}

function prepareUploadDirectory(uploadPath) {
  let probe;
  try {
    fs.mkdirSync(uploadPath, { recursive: true, mode: 0o700 });
    const metadata = fs.lstatSync(uploadPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid upload directory');
    fs.chmodSync(uploadPath, 0o700);
    probe = path.join(uploadPath, `.startup-${randomUUID()}`);
    const descriptor = fs.openSync(probe, 'wx', 0o600);
    fs.closeSync(descriptor);
    fs.unlinkSync(probe);
  } catch {
    if (probe) { try { fs.unlinkSync(probe); } catch {} }
    throw new Error('UPLOAD_PATH must be a writable private directory');
  }
}

module.exports = { loadRuntimeConfig, prepareUploadDirectory };
