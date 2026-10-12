const fs = require('node:fs');
const { X509Certificate } = require('node:crypto');

function invalid(message) {
  const error = new Error(message);
  error.code = 'DATABASE_CONFIG_INVALID';
  return error;
}

function portNumber(value, label) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text) || Number(text) > 65535) {
    throw invalid(`${label} must be an integer between 1 and 65535`);
  }
  return Number(text);
}

function buildDatabaseOptions(env = process.env) {
  let options;
  let urlSsl;
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== '') {
    let url;
    try { url = new URL(env.DATABASE_URL); }
    catch (_) { throw invalid('DATABASE_URL must be a valid PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
      throw invalid('DATABASE_URL must use postgres or postgresql with a host and no fragment');
    }
    const sslModes = url.searchParams.getAll('sslmode');
    if (sslModes.length > 1) throw invalid('DATABASE_URL has repeated sslmode settings');
    urlSsl = sslModes[0];
    const allowedParameters = new Set(['sslmode', 'application_name', 'options']);
    for (const [name] of url.searchParams) {
      if (!allowedParameters.has(name) || url.searchParams.getAll(name).length > 1) {
        throw invalid('DATABASE_URL contains an unsupported or repeated query setting');
      }
    }
    if (urlSsl !== undefined && !['disable', 'require', 'verify-ca', 'verify-full'].includes(urlSsl)) {
      throw invalid('DATABASE_URL sslmode must be disable, require, verify-ca or verify-full');
    }
    try {
      options = {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? portNumber(url.port, 'DATABASE_URL port') : 5432,
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    } catch (error) {
      if (error.code === 'DATABASE_CONFIG_INVALID') throw error;
      throw invalid('DATABASE_URL has invalid percent encoding');
    }
    if (!options.database || !options.user || /[\u0000-\u001f\u007f]/.test(options.database + options.user)) {
      throw invalid('DATABASE_URL requires a database and user');
    }
    for (const name of ['application_name', 'options']) {
      if (url.searchParams.has(name)) options[name] = url.searchParams.get(name);
    }
  } else {
    options = {
      host: env.DB_HOST || 'localhost',
      port: env.DB_PORT === undefined || env.DB_PORT === '' ? 5432 : portNumber(env.DB_PORT, 'DB_PORT'),
      database: env.DB_NAME || 'kntr',
      user: env.DB_USER || 'postgres',
      password: env.DB_PASSWORD,
    };
  }

  const explicitSsl = env.DB_SSL === undefined || env.DB_SSL === '' ? undefined : env.DB_SSL;
  if (explicitSsl !== undefined && !['require', 'disable'].includes(explicitSsl)) {
    throw invalid('DB_SSL must be require or disable');
  }
  const urlRequiresSsl = urlSsl === undefined ? undefined : urlSsl !== 'disable';
  if (explicitSsl !== undefined && urlRequiresSsl !== undefined && (explicitSsl === 'require') !== urlRequiresSsl) {
    throw invalid('DB_SSL conflicts with DATABASE_URL sslmode');
  }
  const requireSsl = explicitSsl === 'require' || urlRequiresSsl === true;
  options.ssl = requireSsl ? { rejectUnauthorized: true } : false;
  if (env.DB_SSL_CA_FILE) {
    if (!requireSsl) throw invalid('DB_SSL_CA_FILE requires TLS; set DB_SSL=require');
    let ca;
    try {
      ca = fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8');
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      if (!certificates?.length || /PRIVATE KEY/.test(ca)) throw new Error('Invalid CA');
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch (_) { throw invalid('DB_SSL_CA_FILE must be a readable PEM certificate bundle'); }
    options.ssl.ca = ca;
  }
  return {
    ...options,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

module.exports = { buildDatabaseOptions };
