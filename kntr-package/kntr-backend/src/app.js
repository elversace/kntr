require('dotenv').config();

const { loadRuntimeConfig, prepareUploadDirectory } = require('./config/runtime');
let runtime;
try {
  runtime = loadRuntimeConfig();
  prepareUploadDirectory(runtime.uploadPath);
} catch (err) {
  console.error('Startup configuration error:', err.message);
  process.exit(1);
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { pool, testConnection } = require('./config/database');
const { validateDatabaseReadiness } = require('./scripts/prepare');
const routes = require('./routes/index');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { setupSocketIO } = require('./services/socketService');

const app = express();
const server = http.createServer(app);
app.set('trust proxy', runtime.trustProxy);

const originAllowed = origin => !origin || runtime.wildcardOrigins || runtime.allowedOrigins.includes(origin);
const corsOptions = {
  origin: runtime.wildcardOrigins ? '*' : runtime.allowedOrigins,
  credentials: !runtime.wildcardOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── Socket.io ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    ...corsOptions,
    methods: ['GET', 'POST'],
  },
  // CORS alone does not protect WebSocket upgrades.
  allowRequest: (req, callback) => callback(null, originAllowed(req.headers.origin)),
  transports: ['websocket', 'polling'],
});

app.set('io', io);
setupSocketIO(io);

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use((req, res, next) => {
  if (!originAllowed(req.headers.origin)) {
    return res.status(403).json({ success: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed' } });
  }
  next();
});
app.use(cors(corsOptions));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[iso]] :method :url :status :res[content-length] - :response-time ms'));
}

// ─── Rate limiting ────────────────────────────────────────────
// Strict limiter on auth endpoints: blocks brute-force login/register attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please try again later.' } },
});
app.use('/v1/auth/login', authLimiter);
app.use('/v1/auth/register', authLimiter);
app.use('/v1/auth/refresh-token', authLimiter);

// General limiter across the rest of the API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/v1', apiLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'kntr API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// Deployment health checks verify the database, not only the Node process.
app.get('/ready', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await validateDatabaseReadiness(pool);
    res.json({ status: 'ok', service: 'kntr API' });
  } catch {
    res.status(503).json({ status: 'unavailable', service: 'kntr API' });
  }
});

// ─── API Routes ───────────────────────────────────────────────
app.use('/v1', routes);

// ─── Error Handling ───────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────
const PORT = runtime.port;

const start = async () => {
  await testConnection();
  await validateDatabaseReadiness(pool);

  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║      🚚  kntr API Server           ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Port:    ${PORT}                         ║`);
    console.log(`║  Env:     ${(process.env.NODE_ENV || 'development').padEnd(10)}                ║`);
    console.log(`║  Base:    http://localhost:${PORT}/v1     ║`);
    console.log(`║  Health:  http://localhost:${PORT}/health ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
  });
};

start().catch((err) => {
  console.error('Startup failed: verify database connection and run npm run db:prepare');
  if (runtime.mode !== 'production') console.error('Database readiness failure:', err.code || 'DATABASE_ERROR', err.message);
  process.exit(1);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await new Promise(resolve => io.close(resolve));
    await pool.end();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error('Server shutdown did not complete');
    process.exit(1);
  }
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

module.exports = { app, server };
