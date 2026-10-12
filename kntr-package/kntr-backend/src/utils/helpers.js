// ─── Response Helpers ───────────────────────────────────────
const success = (res, data, message = 'Success', status = 200) => {
  res.status(status).json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  });
};

const error = (res, message, code = 'ERROR', status = 400, details = null) => {
  const body = {
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  };
  if (details) body.error.details = details;
  res.status(status).json(body);
};

const paginated = (res, data, pagination, message = 'Success') => {
  res.status(200).json({
    success: true,
    data,
    pagination,
    message,
    timestamp: new Date().toISOString(),
  });
};

// ─── Pricing Calculator ──────────────────────────────────────
const PRICING = {
  motorcycle: { '0-10': 10, '11-25': 30, '26-50': 50, '51-100': 100, '100+': 200 },
  car:        { '0-10': 10, '11-25': 30, '26-50': 50, '51-100': 100, '100+': 200 },
  van:        { '0-10': 60, '11-25': 100, '26-50': 150, '51-100': 250, '100+': 400 },
  truck:      { '0-10': 60, '11-25': 100, '26-50': 150, '51-100': 250, '100+': 400 },
};

const PRIORITY_MULTIPLIERS = { standard: 1.0, priority: 1.3, urgent: 1.5 };
const TIER_DISCOUNTS = { bronze: 0, silver: 0.05, gold: 0.10 };

const getBasePrice = (vehicleType, distanceKm) => {
  const tiers = PRICING[vehicleType] || PRICING.car;
  if (distanceKm <= 10)  return tiers['0-10'];
  if (distanceKm <= 25)  return tiers['11-25'];
  if (distanceKm <= 50)  return tiers['26-50'];
  if (distanceKm <= 100) return tiers['51-100'];
  return tiers['100+'];
};

const calculatePrice = ({ vehicleType, distanceKm, priority = 'standard', customerTier = 'bronze', packageCount = 1 }) => {
  const decimalRatio = value => {
    const [mantissa, exponent = '0'] = value.toString().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length - Number(exponent)) };
  };
  const percentageCents = (cents, ratio) => Number(
    (2n * BigInt(cents) * ratio.numerator + ratio.denominator) / (2n * ratio.denominator)
  );
  const rate = (name, fallback) => {
    const setting = process.env[name] ?? String(fallback);
    const value = Number(setting);
    if (setting.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a number between 0 and 1`);
    }
    return decimalRatio(value);
  };
  const VAT_RATE = rate('VAT_RATE', 0.10);
  const COMMISSION_RATE = rate('COMMISSION_RATE', 0.18);

  let basePrice = getBasePrice(vehicleType, distanceKm);

  // Priority multiplier
  basePrice *= (PRIORITY_MULTIPLIERS[priority] || 1.0);

  // Multi-package discount
  const multiDiscounts = [0, 0, 0.10, 0.15, 0.20, 0.25];
  const multiDiscount = multiDiscounts[Math.min(packageCount - 1, multiDiscounts.length - 1)] ?? 0.25;
  if (packageCount > 1) basePrice *= (1 - multiDiscount);

  // Customer tier discount
  const tierDiscount = TIER_DISCOUNTS[customerTier] || 0;
  // Round each charge in cents, then derive the remainder. Independently
  // rounding both shares can make the ledger exceed the amount paid by a cent.
  const baseCents = Math.round(basePrice * 100);
  const discountCents = percentageCents(baseCents, decimalRatio(tierDiscount));
  const netCents = baseCents - discountCents;
  const vatCents = percentageCents(netCents, VAT_RATE);
  const commissionCents = percentageCents(netCents, COMMISSION_RATE);
  const driverCents = netCents - commissionCents;
  const totalCents = netCents + vatCents;

  return {
    basePrice: baseCents / 100,
    customerDiscount: discountCents / 100,
    vatAmount: vatCents / 100,
    totalPrice: totalCents / 100,
    finalPrice: totalCents / 100,
    driverEarnings: driverCents / 100,
    commissionAmount: commissionCents / 100,
  };
};

// ─── Distance Calculator (Haversine) ────────────────────────
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
};

// ─── Customer Tier Updater ───────────────────────────────────
const getCustomerTier = (totalOrders) => {
  if (totalOrders >= 51) return 'gold';
  if (totalOrders >= 11) return 'silver';
  return 'bronze';
};

// ─── Pagination Helper ───────────────────────────────────────
const getPagination = (page = 1, limit = 20) => {
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;
  return { page: p, limit: l, offset };
};

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

module.exports = {
  success, error, paginated,
  calculatePrice, calculateDistance,
  getCustomerTier, getPagination, buildPagination,
};
