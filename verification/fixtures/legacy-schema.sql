-- kntr Database Schema
-- Run: psql -U postgres -d kntr -f schema.sql

-- =====================================================
-- EXTENSIONS
-- =====================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis"; -- For geo queries (optional, fallback below)

-- =====================================================
-- ENUMS
-- =====================================================
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('customer','driver','admin','support','finance','audit','corporate');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active','suspended','pending','deleted');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE customer_tier AS ENUM ('bronze','silver','gold');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE driver_status AS ENUM ('pending','approved','rejected','suspended');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE driver_availability AS ENUM ('available','busy','on_break','offline');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('valid','expiring','expired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('pending','accepted','in_transit','delivered','cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE order_priority AS ENUM ('standard','priority','urgent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','card','wallet','bank_transfer');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending','paid','refunded','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_priority AS ENUM ('low','normal','high','urgent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('open','in_progress','resolved','closed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_type AS ENUM ('delivery_issue','payment_issue','driver_complaint','customer_complaint','app_bug','other');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE payout_status AS ENUM ('pending','processing','completed','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM ('order_update','payment','document_expiry','promotion','system');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('unread','read','archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE corporate_status AS ENUM ('pending','active','suspended');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- =====================================================
-- USERS & AUTH
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name_ar VARCHAR(255) NOT NULL,
  full_name_en VARCHAR(255),
  national_id VARCHAR(50),
  status user_status DEFAULT 'active',
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_secret VARCHAR(255),
  preferred_language VARCHAR(2) DEFAULT 'ar',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) UNIQUE NOT NULL,
  refresh_token VARCHAR(500) UNIQUE,
  device_info JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- CUSTOMERS
-- =====================================================
CREATE TABLE IF NOT EXISTS customers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier customer_tier DEFAULT 'bronze',
  total_orders INTEGER DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0,
  favorite_drivers UUID[],
  saved_addresses JSONB DEFAULT '[]',
  join_date TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- DRIVERS
-- =====================================================
CREATE TABLE IF NOT EXISTS drivers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  driver_status driver_status DEFAULT 'pending',
  availability driver_availability DEFAULT 'offline',
  rating DECIMAL(3,2) DEFAULT 5.00,
  total_trips INTEGER DEFAULT 0,
  total_earnings DECIMAL(10,2) DEFAULT 0,
  bank_account_name VARCHAR(255),
  bank_account_number VARCHAR(50),
  bank_name VARCHAR(255),
  accepts_intercity BOOLEAN DEFAULT FALSE,
  current_lat DECIMAL(10,8),
  current_lng DECIMAL(11,8),
  last_location_update TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL,
  document_url VARCHAR(500) NOT NULL,
  document_number VARCHAR(100),
  issue_date DATE,
  expiry_date DATE,
  status document_status DEFAULT 'valid',
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  vehicle_type VARCHAR(20) NOT NULL,
  plate_number VARCHAR(50) NOT NULL UNIQUE,
  make VARCHAR(100),
  model VARCHAR(100),
  year INTEGER,
  color VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  photos JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ORDERS
-- =====================================================
CREATE SEQUENCE IF NOT EXISTS order_seq START 1;

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(20) PRIMARY KEY DEFAULT ('ORD-' || LPAD(nextval('order_seq')::TEXT, 5, '0')),
  customer_id UUID REFERENCES customers(user_id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(user_id) ON DELETE SET NULL,
  status order_status DEFAULT 'pending',
  priority order_priority DEFAULT 'standard',

  pickup_address TEXT NOT NULL,
  pickup_lat DECIMAL(10,8) NOT NULL,
  pickup_lng DECIMAL(11,8) NOT NULL,
  pickup_contact_name VARCHAR(255),
  pickup_contact_phone VARCHAR(20),

  dropoff_address TEXT NOT NULL,
  dropoff_lat DECIMAL(10,8) NOT NULL,
  dropoff_lng DECIMAL(11,8) NOT NULL,
  dropoff_contact_name VARCHAR(255),
  dropoff_contact_phone VARCHAR(20),

  package_description TEXT,
  package_weight DECIMAL(6,2),
  package_photos JSONB DEFAULT '[]',
  package_count INTEGER DEFAULT 1,
  special_instructions TEXT,

  distance DECIMAL(6,2) NOT NULL,
  vehicle_type VARCHAR(20) NOT NULL,
  base_price DECIMAL(10,2) NOT NULL,
  vat_amount DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) NOT NULL,
  customer_discount DECIMAL(10,2) DEFAULT 0,
  final_price DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'LYD',

  driver_earnings DECIMAL(10,2),
  commission_amount DECIMAL(10,2),
  tip_amount DECIMAL(10,2) DEFAULT 0,

  payment_method payment_method,
  payment_status payment_status DEFAULT 'pending',
  payment_transaction_id VARCHAR(255),

  scheduled_pickup_time TIMESTAMPTZ,
  is_scheduled BOOLEAN DEFAULT FALSE,

  accepted_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  cancelled_by UUID REFERENCES users(id),
  cancellation_fee DECIMAL(10,2),

  qr_code VARCHAR(255) UNIQUE,
  qr_generated_at TIMESTAMPTZ,
  qr_scanned_at TIMESTAMPTZ,
  delivery_photo_url VARCHAR(500),
  delivery_signature JSONB,
  delivery_lat DECIMAL(10,8),
  delivery_lng DECIMAL(11,8),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(20) REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(user_id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_counter_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(20) REFERENCES orders(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  offered_price DECIMAL(10,2) NOT NULL,
  reason TEXT,
  customer_response VARCHAR(20),
  customer_counter_price DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

-- =====================================================
-- FINANCIAL
-- =====================================================
CREATE SEQUENCE IF NOT EXISTS payout_seq START 1;

CREATE TABLE IF NOT EXISTS driver_payouts (
  id VARCHAR(20) PRIMARY KEY DEFAULT ('PAY-' || LPAD(nextval('payout_seq')::TEXT, 5, '0')),
  driver_id UUID REFERENCES drivers(user_id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_earnings DECIMAL(10,2) NOT NULL,
  total_trips INTEGER NOT NULL,
  status payout_status DEFAULT 'pending',
  bank_reference VARCHAR(255),
  processed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance DECIMAL(10,2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'LYD',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  order_id VARCHAR(20) REFERENCES orders(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'LYD',
  payment_method payment_method,
  gateway_transaction_id VARCHAR(255),
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(20) REFERENCES orders(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- =====================================================
-- SUPPORT
-- =====================================================
CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1;

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(20) PRIMARY KEY DEFAULT ('T-' || LPAD(nextval('ticket_seq')::TEXT, 5, '0')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  order_id VARCHAR(20) REFERENCES orders(id) ON DELETE SET NULL,
  type ticket_type NOT NULL,
  priority ticket_priority DEFAULT 'normal',
  status ticket_status DEFAULT 'open',
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id VARCHAR(20) REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  attachments JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- CORPORATE
-- =====================================================
CREATE SEQUENCE IF NOT EXISTS corp_seq START 1;
CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;

CREATE TABLE IF NOT EXISTS corporate_accounts (
  id VARCHAR(20) PRIMARY KEY DEFAULT ('CORP-' || LPAD(nextval('corp_seq')::TEXT, 5, '0')),
  company_name_ar VARCHAR(255) NOT NULL,
  company_name_en VARCHAR(255),
  business_license VARCHAR(100),
  tax_id VARCHAR(100),
  contact_person_name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  billing_address TEXT,
  status corporate_status DEFAULT 'pending',
  discount_percentage DECIMAL(5,2) DEFAULT 0,
  credit_limit DECIMAL(12,2) DEFAULT 0,
  current_balance DECIMAL(12,2) DEFAULT 0,
  payment_terms INTEGER DEFAULT 30,
  monthly_orders INTEGER DEFAULT 0,
  api_key VARCHAR(255) UNIQUE,
  api_key_expires_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS corporate_users (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  corporate_id VARCHAR(20) REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  is_admin BOOLEAN DEFAULT FALSE,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS corporate_invoices (
  id VARCHAR(20) PRIMARY KEY DEFAULT ('INV-' || LPAD(nextval('invoice_seq')::TEXT, 5, '0')),
  corporate_id VARCHAR(20) REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  total_orders INTEGER NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL,
  vat_amount DECIMAL(12,2) NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  paid BOOLEAN DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  payment_reference VARCHAR(255),
  due_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- NOTIFICATIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title_ar VARCHAR(255) NOT NULL,
  title_en VARCHAR(255),
  message_ar TEXT NOT NULL,
  message_en TEXT,
  data JSONB,
  status notification_status DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status);

-- =====================================================
-- AUDIT
-- =====================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(50),
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- =====================================================
-- SYSTEM SETTINGS
-- =====================================================
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_settings (key, value) VALUES
('pricing', '{
  "vat_rate": 0.10,
  "commission_rate": 0.18,
  "surge_multiplier": 1.5,
  "base_prices": {
    "motorcycle": {"0-10": 10, "11-25": 30, "26-50": 50, "51-100": 100, "100+": 200},
    "car":        {"0-10": 10, "11-25": 30, "26-50": 50, "51-100": 100, "100+": 200},
    "van":        {"0-10": 60, "11-25": 100, "26-50": 150, "51-100": 250, "100+": 400},
    "truck":      {"0-10": 60, "11-25": 100, "26-50": 150, "51-100": 250, "100+": 400}
  },
  "priority_multiplier": 1.3,
  "urgent_multiplier": 1.5
}'),
('customer_tiers', '{
  "bronze": {"min_orders": 0,  "discount": 0},
  "silver": {"min_orders": 11, "discount": 0.05},
  "gold":   {"min_orders": 51, "discount": 0.10}
}')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- PROHIBITED ITEMS
-- =====================================================
CREATE TABLE IF NOT EXISTS prohibited_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NOT NULL,
  icon VARCHAR(10),
  active BOOLEAN DEFAULT TRUE
);

INSERT INTO prohibited_items (name_ar, name_en, icon) VALUES
('المواد القابلة للاشتعال', 'Flammable materials', '🔥'),
('المواد الكيميائية الخطرة', 'Hazardous chemicals', '☣️'),
('المخدرات وغير القانونية', 'Narcotics and illegal substances', '💊'),
('الأسلحة والذخيرة', 'Weapons and ammunition', '🔫'),
('الحيوانات الحية', 'Live animals', '🐕'),
('مبالغ نقدية كبيرة', 'Large cash amounts over 5000 LYD', '💰')
ON CONFLICT DO NOTHING;
