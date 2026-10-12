# 🚚 kntr Backend API

Node.js + Express + PostgreSQL backend for the kntr delivery platform.

For deployment preparation and current service settings, see [Railway setup](RAILWAY-SETUP-AR.md).

## 📁 Project Structure

```
kntr-backend/
├── src/
│   ├── app.js                    # Entry point
│   ├── config/
│   │   └── database.js           # PostgreSQL connection pool
│   ├── controllers/
│   │   ├── authController.js     # Register, login, JWT, logout
│   │   ├── ordersController.js   # Create, track, QR, rate orders
│   │   ├── driversController.js  # Availability, location, earnings
│   │   └── adminController.js    # Stats, approvals, finance
│   ├── middleware/
│   │   ├── auth.js               # JWT verify + role guards
│   │   └── errorHandler.js       # Global error + audit logger
│   ├── routes/
│   │   └── index.js              # All API routes with validation
│   ├── services/
│   │   └── socketService.js      # Socket.io real-time events
│   └── utils/
│       ├── jwt.js                # Token generation/verify
│       └── helpers.js            # Pricing, distance, pagination
├── schema.sql                    # Full PostgreSQL schema
└── package.json
```

## 🚀 Quick Setup

### 1. Prerequisites
- Node.js 18.11+ (a supported Node.js release is recommended)
- PostgreSQL 15+
- npm

### 2. Install
```bash
npm ci
```

### 3. Configure Environment
```bash
cp .env.example .env
# Fill DB_* or DATABASE_URL, then set two independent JWT secrets.
# Generate each value separately with: openssl rand -hex 32
# Never commit .env or real credentials.
```

### 4. Prepare Database
Use a PostgreSQL database supplied by your host, or create a local empty database first. The command uses the same DB_* or DATABASE_URL settings as the application.

```bash
npm run db:prepare
```

An empty database is initialized transactionally. Existing KNTR databases receive numbered migrations with recorded checksums; partial schemas or financial inconsistencies stop preparation. Back up existing data and stop the application before upgrading. `npm run db:migrate` is an alias for this command.

### 5. Run
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server starts at: `http://localhost:3000`

---

## 🔌 API Reference

### Base URL
```
http://localhost:3000/v1
```

### Authentication
All protected routes require:
```
Authorization: Bearer <access_token>
```

---

### 🔐 Auth Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/auth/register` | ❌ | Register customer or driver |
| POST | `/auth/login` | ❌ | Login, returns JWT tokens |
| POST | `/auth/refresh-token` | ❌ | Refresh access token |
| POST | `/auth/logout` | ✅ | Invalidate session |
| GET | `/auth/me` | ✅ | Get current user profile |
| PUT | `/auth/change-password` | ✅ | Change password |

**Register example:**
```json
POST /v1/auth/register
{
  "role": "customer",
  "email": "ahmed@example.com",
  "phone": "+218912345678",
  "password": "SecurePass123",
  "full_name_ar": "أحمد محمد",
  "full_name_en": "Ahmed Mohamed",
  "preferred_language": "ar"
}
```

---

### 📦 Order Endpoints

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/orders/estimate` | Optional | Price estimate |
| POST | `/orders` | Customer | Create new order |
| GET | `/orders` | All | List orders (filtered by role) |
| GET | `/orders/:id` | All | Get order details |
| PATCH | `/orders/:id/status` | Driver/Admin | Update status |
| POST | `/orders/:id/cancel` | All | Cancel order |
| POST | `/orders/:id/generate-qr` | Driver | Generate delivery QR |
| POST | `/orders/:id/verify-qr` | Customer (owner) | Confirm receipt and cash payment via QR |
| POST | `/orders/:id/rate` | Customer | Rate completed order |

**Order Status Flow:**
```
pending → accepted → in_transit → delivered
   ↓           ↓           ↓
cancelled  cancelled   cancelled
```

---

### 🏍 Driver Endpoints

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/drivers/orders` | Driver | Browse available orders |
| POST | `/drivers/orders/:id/accept` | Driver | Accept an order |
| PATCH | `/drivers/availability` | Driver | Set availability |
| PATCH | `/drivers/location` | Driver | Update GPS location |
| GET | `/drivers/earnings` | Driver | Earnings summary |
| GET | `/drivers/profile` | Driver | Own profile |
| POST | `/drivers/documents` | Driver | Upload document (multipart) |
| POST | `/drivers/vehicles` | Driver | Register vehicle |
| POST | `/drivers/panic` | Driver | Emergency alert 🚨 |

---

### 👑 Admin Endpoints

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/admin/statistics` | Admin | Dashboard KPIs |
| GET | `/admin/live-map` | Admin | Active drivers + orders |
| GET | `/admin/drivers/pending` | Admin | Pending approvals |
| POST | `/admin/drivers/:id/approve` | Admin | Approve driver |
| POST | `/admin/drivers/:id/reject` | Admin | Reject driver |
| GET | `/admin/users` | Admin | List all users |
| PATCH | `/admin/users/:id/status` | Admin | Suspend/activate user |
| GET | `/admin/finance` | Finance | Revenue overview |
| POST | `/admin/payouts` | Finance | Process driver payout |
| GET | `/admin/settings` | Admin | System settings |
| PUT | `/admin/settings` | Admin | Update settings |

---

## ⚡ WebSocket Events

Connect with Socket.io:
```javascript
const socket = io('http://localhost:3000', {
  auth: { token: 'your_jwt_token' }
});
```

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `track_order` | `{ order_id }` | Subscribe to order updates |
| `join_driver_room` | `{ vehicle_type }` | Driver joins order feed |
| `driver_location` | `{ lat, lng, order_id }` | Driver broadcasts location |
| `chat_message` | `{ order_id, message }` | In-order chat |

### Server → Client
| Event | Description |
|-------|-------------|
| `new_order` | New order available for drivers |
| `driver_accepted` | Driver accepted this order |
| `order_status_updated` | Order status changed |
| `driver_location_update` | Driver moved |
| `order_delivered` | Delivery confirmed |
| `order_cancelled` | Order was cancelled |
| `panic_alert` | Driver emergency (admins only) |

---

## 💰 Pricing Logic

| Vehicle | 0-10km | 11-25km | 26-50km | 51-100km | 100+km |
|---------|--------|---------|---------|----------|--------|
| Motorcycle/Car | 10 د.ل | 30 | 50 | 100 | 200 |
| Van/Truck | 60 د.ل | 100 | 150 | 250 | 400 |

**Multipliers:**
- Priority: ×1.3
- Urgent: ×1.5
- Customer Silver tier: −5%
- Customer Gold tier: −10%
- VAT: +10%

---

## 🛡 Security Features

- JWT access tokens (24h) + refresh tokens (7d)
- bcrypt password hashing (12 rounds)
- Session management with DB validation
- Role-based access control (7 roles)
- Request validation on all endpoints
- Audit logging for all critical actions
- Automatic session revocation on suspend/password change

---

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `DB_HOST` | PostgreSQL host | localhost |
| `DB_PORT` | PostgreSQL port | 5432 |
| `DB_NAME` | Database name | kntr |
| `DB_USER` | PostgreSQL user | postgres |
| `DB_PASSWORD` | PostgreSQL password | — |
| `JWT_SECRET` | JWT signing key | — |
| `JWT_REFRESH_SECRET` | Independent refresh signing key | — |
| `JWT_EXPIRES_IN` | Token expiry | 24h |
| `VAT_RATE` | VAT percentage | 0.10 |
| `COMMISSION_RATE` | Platform commission | 0.18 |
| `QR_EXPIRY_MINUTES` | QR code validity | 60 |
| `UPLOAD_PATH` | Private document directory | backend/uploads |
| `MAX_FILE_SIZE` | Upload byte limit (capped at 5 MiB) | 5242880 |

`npm run dev` uses Node's built-in watch mode. Install the versions in
`package-lock.json` with `npm ci`; development no longer requires nodemon.

## Delivery confirmation contract

The approved assigned driver generates a QR code only while the order is
`in_transit`. Repeated generation returns the same unused code until it expires.
Only the authenticated customer who owns the order can submit `verify-qr`, with
`qr_code` and `received: true`. Cash orders additionally require `cash_paid: true`.

### Upgrade an existing database

Back up the database and uploaded documents, stop the API, and configure the
target database through `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and
`DB_PASSWORD` in the environment or `.env`. After installing dependencies, run:

```bash
npm run db:upgrade
```

The command applies numbered SQL migrations in order and stops on the first
error. Repeat runs are supported. Financial duplicates or invalid historical
balances require accounting reconciliation; the command preserves these records
and reports the issue instead of guessing a correction. Restart the API only
after every migration succeeds. `schema.sql` is for a new database.
Noncash orders require an existing completed payment ledger entry matching the
customer, amount, currency and payment method; confirming delivery cannot create
an unverified noncash payment. The driver and admin cannot bypass this process by
setting `status: delivered`. Ordinary order responses do not expose the QR secret.

Receipt, payment recording and driver/customer statistics commit together.
Consumed codes and finalized orders reject retries without repeating accounting.
For an existing database, run `migrations/001_delivery_integrity.sql` with
`ON_ERROR_STOP=1` before starting the updated service. Historical duplicate ledger
entries block this migration and must be reconciled while preserving their audit
history; the migration never deletes financial records.

## Wallet payments, cancellation and payout reservations

Wallet orders debit the exact order amount at creation. The order, debit and
completed payment ledger entry commit together; insufficient funds return
`409 INSUFFICIENT_BALANCE` and do not create an order. A wallet currency mismatch
returns `409 PAYMENT_MISMATCH`. Creation returns `payment_status`,
`payment_transaction_id` and the resulting `wallet_balance` as a decimal string
(or `null` for cash). Delivery reuses the original payment and never debits again.
Card and bank-transfer creation return `409 PAYMENT_UNAVAILABLE` because this
package has no configured payment provider or verified payment callback.

Cancelling a funded wallet order returns the entire original debit once, with
zero cancellation fee. The wallet credit, completed refund ledger, refund record
and cancelled/refunded order commit together. Legacy unfunded pending orders
cancel without a fabricated refund. Inconsistent charges/refunds or paid legacy
cash/card/bank orders return `409 PAYMENT_MISMATCH` for manual reconciliation.
An accepted or in-transit unpaid cash order retains the existing recorded fee of
5 LYD; this API does not collect that fee automatically.

Payouts reserve individual paid orders through `payout_items.order_id`; the same
order cannot appear in another payout even when date ranges overlap. Only funded
driver earnings qualify; unfunded tips are excluded. Payouts remain `pending`
until an actual transfer is confirmed. Drivers with active legacy payouts lacking
order allocations require reconciliation before new payouts can be created.

Existing installations must also run `migrations/002_payment_integrity.sql` with
`ON_ERROR_STOP=1`. Null, negative or nonfinite wallet balances and invalid currency
records block migration without changing financial data. Reconcile those records
against the ledger before retrying; no historical payout allocations are guessed.

## Private driver documents

Driver document uploads accept JPEG, PNG and PDF files up to 5 MiB. The filename,
declared MIME type and actual file signature must agree. Invalid files, metadata
and failed database writes remove the new upload. Uploads create or replace one
row per driver and document type, reset approval metadata, and derive document
status from the expiry date: past dates are `expired`, today through 30 days ahead
are `expiring`, and later/missing dates are `valid`.

The returned `document_id` and `document_url` identify an authenticated download
at `/v1/drivers/documents/:document_id/file`. Only that driver and an admin can
download it. Files use attachment disposition, their verified content type, and
`nosniff`; the previous public `/uploads` route is disabled. Storage filenames
remain internal. Replacement cleanup keeps any file still referenced by another
current document or by the document archive.

Run `migrations/003_document_integrity.sql` after the two financial migrations.
It preserves complete duplicate and orphan rows in `driver_document_archive`,
keeps the newest active document per type, and installs the required unique
constraint. Safe legacy filenames migrate to authenticated URLs. Invalid legacy
paths return 404. The migration is repeatable and never deletes physical files.
