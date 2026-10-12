const express = require('express');
const { body, query: qv, param } = require('express-validator');
const { uploadDocumentFile, cleanupUploadedFile } = require('../middleware/documentUpload');

const { authenticate, isAdmin, isDriver, isApprovedDriver, isCustomer, isSupport, isFinance, optionalAuth } = require('../middleware/auth');

const authCtrl   = require('../controllers/authController');
const ordersCtrl = require('../controllers/ordersController');
const driversCtrl = require('../controllers/driversController');
const adminCtrl  = require('../controllers/adminController');

const router = express.Router();

// ─── Validation middleware helper ─────────────────────────────
const { validationResult } = require('express-validator');
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() },
      timestamp: new Date().toISOString(),
    });
  }
  next();
};
const documentDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validateDocument = async (req, res, next) => {
  try {
    if (!validationResult(req).isEmpty()) await cleanupUploadedFile(req);
    validate(req, res, next);
  } catch (err) { next(err); }
};

// ============================================================
// AUTH ROUTES
// ============================================================
router.post('/auth/register',
  [
    body('role').isIn(['customer', 'driver']),
    body('email').isEmail().normalizeEmail(),
    body('phone').matches(/^\+?[0-9]{10,15}$/),
    body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
    body('full_name_ar').trim().isLength({ min: 2 }),
    body('preferred_language').optional().isIn(['ar', 'en']),
  ],
  validate,
  authCtrl.register
);

router.post('/auth/login',
  [
    body('password').notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('phone').optional().matches(/^\+?[0-9]{10,15}$/),
  ],
  validate,
  authCtrl.login
);

router.post('/auth/refresh-token',
  body('refresh_token').notEmpty(),
  validate,
  authCtrl.refreshToken
);

router.post('/auth/logout', authenticate, authCtrl.logout);
router.get('/auth/me', authenticate, authCtrl.getMe);

router.put('/auth/change-password',
  authenticate,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  ],
  validate,
  authCtrl.changePassword
);

// ============================================================
// ORDER ROUTES
// ============================================================

// Price estimate (public with optional auth)
router.get('/orders/estimate',
  optionalAuth,
  [
    qv('pickup_lat').isFloat(),
    qv('pickup_lng').isFloat(),
    qv('dropoff_lat').isFloat(),
    qv('dropoff_lng').isFloat(),
    qv('vehicle_type').isIn(['motorcycle', 'car', 'van', 'truck']),
  ],
  validate,
  ordersCtrl.estimatePrice
);

router.post('/orders',
  authenticate,
  isCustomer,
  [
    body('pickup.address').notEmpty(),
    body('pickup.lat').isFloat({ min: -90, max: 90 }),
    body('pickup.lng').isFloat({ min: -180, max: 180 }),
    body('dropoff.address').notEmpty(),
    body('dropoff.lat').isFloat({ min: -90, max: 90 }),
    body('dropoff.lng').isFloat({ min: -180, max: 180 }),
    body('vehicle_type').isIn(['motorcycle', 'car', 'van', 'truck']),
    body('priority').optional().isIn(['standard', 'priority', 'urgent']),
    body('package_count').optional().isInt({ min: 1, max: 50 }),
    body('payment_method').optional().isIn(['cash', 'card', 'wallet', 'bank_transfer']),
  ],
  validate,
  ordersCtrl.createOrder
);

router.get('/orders', authenticate, ordersCtrl.getOrders);
router.get('/orders/:order_id', authenticate, ordersCtrl.getOrder);

router.patch('/orders/:order_id/status',
  authenticate,
  [
    body('status').isIn(['accepted', 'in_transit', 'delivered', 'cancelled']),
    body('vehicle_id').optional().isUUID(),
    body('reason').optional().isString(),
  ],
  validate,
  ordersCtrl.updateStatus
);

router.post('/orders/:order_id/cancel',
  authenticate,
  body('reason').optional().isString(),
  validate,
  ordersCtrl.cancelOrder
);

router.post('/orders/:order_id/generate-qr',
  authenticate,
  isDriver,
  isApprovedDriver,
  ordersCtrl.generateQR
);

router.post('/orders/:order_id/verify-qr',
  authenticate,
  [
    body('qr_code').isString().matches(/^[A-Fa-f0-9]{32}$/),
    body('received').optional().custom(value => typeof value === 'boolean'),
    body('cash_paid').optional().custom(value => typeof value === 'boolean'),
    body('lat').optional().isFloat({ min: -90, max: 90 }),
    body('lng').optional().isFloat({ min: -180, max: 180 }),
  ],
  validate,
  ordersCtrl.verifyQR
);

router.post('/orders/:order_id/rate',
  authenticate,
  isCustomer,
  [
    body('rating').isInt({ min: 1, max: 5 }),
    body('review_text').optional().isString().isLength({ max: 500 }),
  ],
  validate,
  ordersCtrl.rateOrder
);

// ============================================================
// DRIVER ROUTES
// ============================================================
router.get('/drivers/orders', authenticate, isDriver, driversCtrl.getAvailableOrders);
router.post('/drivers/orders/:order_id/accept',
  authenticate,
  isDriver,
  body('vehicle_id').optional().isUUID(),
  validate,
  driversCtrl.acceptOrder
);

router.patch('/drivers/availability',
  authenticate,
  isDriver,
  isApprovedDriver,
  body('status').isIn(['available', 'busy', 'on_break', 'offline']),
  validate,
  driversCtrl.updateAvailability
);

router.patch('/drivers/location',
  authenticate,
  isDriver,
  isApprovedDriver,
  [
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
  ],
  validate,
  driversCtrl.updateLocation
);

router.get('/drivers/earnings', authenticate, isDriver, driversCtrl.getEarnings);
router.get('/drivers/profile', authenticate, isDriver, driversCtrl.getDriverProfile);
router.get('/drivers/:driver_id/profile', authenticate, isAdmin, driversCtrl.getDriverProfile);

router.post('/drivers/documents',
  authenticate,
  isDriver,
  uploadDocumentFile,
  [
    body('document_type').isString().bail().isIn(['license', 'insurance', 'registration', 'criminal_record']),
    body('document_number').optional({ values: 'falsy' }).isString().bail().isLength({ max: 100 }),
    body('issue_date').optional({ values: 'falsy' }).custom(documentDate),
    body('expiry_date').optional({ values: 'falsy' }).custom(documentDate)
      .custom((value, { req }) => !req.body.issue_date || value >= req.body.issue_date),
  ],
  validateDocument,
  driversCtrl.uploadDocument
);
router.get('/drivers/documents/:document_id/file',
  authenticate,
  param('document_id').isUUID(),
  validate,
  driversCtrl.getDocumentFile
);

router.post('/drivers/vehicles',
  authenticate,
  isDriver,
  [
    body('vehicle_type').isIn(['motorcycle', 'car', 'van', 'truck']),
    body('plate_number').notEmpty().trim(),
  ],
  validate,
  driversCtrl.addVehicle
);

router.post('/drivers/panic',
  authenticate,
  isDriver,
  isApprovedDriver,
  [
    body('lat').isFloat(),
    body('lng').isFloat(),
  ],
  validate,
  driversCtrl.panicButton
);

// ============================================================
// ADMIN ROUTES
// ============================================================
router.get('/admin/statistics', authenticate, isAdmin, adminCtrl.getStatistics);
router.get('/admin/live-map', authenticate, isAdmin, adminCtrl.getLiveMap);

router.get('/admin/drivers/pending', authenticate, isAdmin, adminCtrl.getPendingDrivers);
router.post('/admin/drivers/:driver_id/approve', authenticate, isAdmin, adminCtrl.approveDriver);
router.post('/admin/drivers/:driver_id/reject',
  authenticate,
  isAdmin,
  body('reason').notEmpty(),
  validate,
  adminCtrl.rejectDriver
);

router.get('/admin/users', authenticate, isAdmin, adminCtrl.getUsers);
router.patch('/admin/users/:user_id/status',
  authenticate,
  isAdmin,
  body('status').isIn(['active', 'suspended']),
  validate,
  adminCtrl.updateUserStatus
);

router.get('/admin/finance', authenticate, isFinance, adminCtrl.getFinancialOverview);
router.post('/admin/payouts',
  authenticate,
  isFinance,
  [
    body('driver_id').isUUID(),
    body('period_start').isString().bail().matches(/^\d{4}-\d{2}-\d{2}$/).bail().isISO8601({ strict: true }).bail()
      .custom(value => Number(value.slice(0, 4)) >= 1900),
    body('period_end').isString().bail().matches(/^\d{4}-\d{2}-\d{2}$/).bail().isISO8601({ strict: true }).bail()
      .custom((value, { req }) => Number(value.slice(0, 4)) >= 1900 && value >= req.body.period_start),
  ],
  validate,
  adminCtrl.processPayout
);

router.get('/admin/settings', authenticate, isAdmin, adminCtrl.getSettings);
router.put('/admin/settings',
  authenticate,
  isAdmin,
  [body('key').notEmpty(), body('value').notEmpty()],
  validate,
  adminCtrl.updateSettings
);

module.exports = router;
