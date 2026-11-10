-- ============================================================================
-- Migration 001: Core Schema for TradeBridge B2B Operations Platform
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Private schema for internal RLS helpers & sync triggers (never exposed to PostgREST)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

-- Sequences for human-readable document numbers
CREATE SEQUENCE IF NOT EXISTS public.order_number_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS public.po_number_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1001;

-- ============================================================================
-- 1. ROLES & USERS
-- ============================================================================

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name IN ('admin', 'staff', 'customer')),
  description text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.roles (name, description, permissions) VALUES
  ('admin', 'Agency owner / super administrator with full system control', '{"all": true}'::jsonb),
  ('staff', 'Authorized agency operations staff managing catalog, orders, and POs', '{"manage_catalog": true, "manage_orders": true, "manage_po": true, "manage_inventory": true, "manage_invoices": true}'::jsonb),
  ('customer', 'Registered local business buyer accessing the Customer Portal only', '{"browse_catalog": true, "place_orders": true, "view_own_invoices": true}'::jsonb)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id),
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role_id ON public.users(role_id);
CREATE INDEX idx_users_email ON public.users(email);

-- ============================================================================
-- 2. AGENCY SETTINGS
-- ============================================================================

CREATE TABLE public.agency_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agency_name text NOT NULL DEFAULT 'TradeBridge B2B Supply Agency',
  legal_name text NOT NULL DEFAULT 'TradeBridge Distribution Pvt. Ltd.',
  gstin text NOT NULL DEFAULT '',
  pan text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'Telangana',
  pincode text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  logo_url text,
  default_gst_rate numeric(5,2) NOT NULL DEFAULT 18.00 CHECK (default_gst_rate >= 0 AND default_gst_rate <= 100),
  currency_symbol text NOT NULL DEFAULT '₹',
  order_prefix text NOT NULL DEFAULT 'ORD',
  po_prefix text NOT NULL DEFAULT 'PO',
  invoice_prefix text NOT NULL DEFAULT 'INV',
  bank_details text DEFAULT '',
  terms_and_conditions text DEFAULT 'Goods once sold will not be taken back. Payment due within agreed credit terms.',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.agency_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 3. CATEGORIES & MANUFACTURERS (No Manufacturer Login/Portal)
-- ============================================================================

CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  image_url text,
  description text,
  parent_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_categories_parent_id ON public.categories(parent_id);
CREATE INDEX idx_categories_status ON public.categories(status);

CREATE TABLE public.manufacturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  logo_url text,
  gallery_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_person text NOT NULL,
  phone text NOT NULL,
  email text,
  website text,
  address text NOT NULL,
  city text,
  state text,
  gst_number text,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_manufacturers_status ON public.manufacturers(status);
CREATE INDEX idx_manufacturers_company_name ON public.manufacturers(company_name);

CREATE TABLE public.manufacturer_categories (
  manufacturer_id uuid NOT NULL REFERENCES public.manufacturers(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manufacturer_id, category_id)
);

CREATE INDEX idx_manufacturer_categories_category_id ON public.manufacturer_categories(category_id);

-- ============================================================================
-- 4. PRODUCTS, IMAGES, MARGIN ENGINE & PRICING
-- ============================================================================

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id uuid NOT NULL REFERENCES public.manufacturers(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  name text NOT NULL,
  sku text NOT NULL UNIQUE,
  description text,
  unit_of_measurement text NOT NULL DEFAULT 'pcs',
  min_order_quantity numeric(12,2) NOT NULL DEFAULT 1 CHECK (min_order_quantity > 0),
  hsn_code text,
  gst_rate numeric(5,2) NOT NULL DEFAULT 18.00 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  is_published boolean NOT NULL DEFAULT false,
  is_featured boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_manufacturer_id ON public.products(manufacturer_id);
CREATE INDEX idx_products_category_id ON public.products(category_id);
CREATE INDEX idx_products_published_status ON public.products(is_published, status);

CREATE TABLE public.product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_images_product_id ON public.product_images(product_id);

CREATE TABLE public.margin_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'category', 'product')),
  category_id uuid REFERENCES public.categories(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id) ON DELETE CASCADE,
  margin_percentage numeric(7,2) NOT NULL CHECK (margin_percentage >= 0 AND margin_percentage <= 500),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_margin_rule_scope CHECK (
    (scope = 'global' AND category_id IS NULL AND product_id IS NULL) OR
    (scope = 'category' AND category_id IS NOT NULL AND product_id IS NULL) OR
    (scope = 'product' AND product_id IS NOT NULL AND category_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_margin_rules_global ON public.margin_rules(scope) WHERE scope = 'global' AND is_active = true;
CREATE UNIQUE INDEX uq_margin_rules_category ON public.margin_rules(category_id) WHERE scope = 'category' AND is_active = true;
CREATE UNIQUE INDEX uq_margin_rules_product ON public.margin_rules(product_id) WHERE scope = 'product' AND is_active = true;
CREATE INDEX idx_margin_rules_category_id ON public.margin_rules(category_id);
CREATE INDEX idx_margin_rules_product_id ON public.margin_rules(product_id);
CREATE INDEX idx_margin_rules_updated_by ON public.margin_rules(updated_by);

-- Default global margin rule (15%)
INSERT INTO public.margin_rules (scope, margin_percentage, notes)
VALUES ('global', 15.00, 'Default agency global margin')
ON CONFLICT DO NOTHING;

CREATE TABLE public.product_prices (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  published_manufacturer_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (published_manufacturer_price >= 0),
  published_margin_source text NOT NULL DEFAULT 'global' CHECK (published_margin_source IN ('global', 'category', 'product', 'manual')),
  published_margin_percentage numeric(7,2) NOT NULL DEFAULT 0 CHECK (published_margin_percentage >= 0),
  published_margin_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (published_margin_amount >= 0),
  published_selling_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (published_selling_price >= 0),
  published_at timestamptz,
  draft_manufacturer_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (draft_manufacturer_price >= 0),
  draft_margin_source text NOT NULL DEFAULT 'global' CHECK (draft_margin_source IN ('global', 'category', 'product', 'manual')),
  draft_margin_percentage numeric(7,2) NOT NULL DEFAULT 0 CHECK (draft_margin_percentage >= 0),
  draft_margin_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (draft_margin_amount >= 0),
  draft_selling_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (draft_selling_price >= 0),
  approval_status text NOT NULL DEFAULT 'pending_review' CHECK (approval_status IN ('published', 'pending_review')),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  old_manufacturer_price numeric(12,2),
  new_manufacturer_price numeric(12,2) NOT NULL,
  old_margin_percentage numeric(7,2),
  new_margin_percentage numeric(7,2) NOT NULL,
  old_selling_price numeric(12,2),
  new_selling_price numeric(12,2) NOT NULL,
  action text NOT NULL CHECK (action IN ('draft_calculated', 'approved_published')),
  notes text,
  changed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_price_history_product_id ON public.price_history(product_id);
CREATE INDEX idx_price_history_created_at ON public.price_history(created_at DESC);

-- ============================================================================
-- 5. INVENTORY
-- ============================================================================

CREATE TABLE public.inventory (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  available_quantity numeric(12,2) NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
  reserved_quantity numeric(12,2) NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  sold_quantity numeric(12,2) NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
  low_stock_threshold numeric(12,2) NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN ('restock', 'manual_adjustment', 'order_reserved', 'order_released', 'order_sold')),
  quantity_delta numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  reference_type text,
  reference_id uuid,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_movements_product_id ON public.inventory_movements(product_id);
CREATE INDEX idx_inventory_movements_created_at ON public.inventory_movements(created_at DESC);

-- ============================================================================
-- 6. CUSTOMERS, ADDRESSES, CUSTOMER PRICING & CART
-- ============================================================================

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
  business_name text NOT NULL,
  owner_name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL UNIQUE,
  business_address text NOT NULL,
  city text,
  state text NOT NULL DEFAULT 'Telangana',
  pincode text,
  gst_number text,
  business_category text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_status ON public.customers(status);

CREATE TABLE public.customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Primary Warehouse',
  contact_name text,
  contact_phone text,
  address_line text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  pincode text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_addresses_customer_id ON public.customer_addresses(customer_id);

CREATE TABLE public.customer_product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  custom_selling_price numeric(12,2) NOT NULL CHECK (custom_selling_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, product_id)
);

CREATE INDEX idx_customer_product_prices_customer_id ON public.customer_product_prices(customer_id);
CREATE INDEX idx_customer_product_prices_product_id ON public.customer_product_prices(product_id);

-- Customer-safe catalog projection (NO manufacturer_id, NO cost, NO margin)
CREATE TABLE public.published_catalog (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  sku text NOT NULL UNIQUE,
  description text,
  unit_of_measurement text NOT NULL,
  min_order_quantity numeric(12,2) NOT NULL,
  hsn_code text,
  gst_rate numeric(5,2) NOT NULL,
  selling_price numeric(12,2) NOT NULL,
  available_quantity numeric(12,2) NOT NULL DEFAULT 0,
  stock_status text NOT NULL DEFAULT 'out_of_stock' CHECK (stock_status IN ('in_stock', 'low_stock', 'out_of_stock')),
  primary_image_url text,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_featured boolean NOT NULL DEFAULT false,
  is_published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_published_catalog_category_id ON public.published_catalog(category_id);
CREATE INDEX idx_published_catalog_published ON public.published_catalog(is_published, is_featured);

CREATE TABLE public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  cart_status text NOT NULL DEFAULT 'active' CHECK (cart_status IN ('active', 'ordered')),
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, product_id)
);

CREATE INDEX idx_cart_items_customer_id ON public.cart_items(customer_id);
CREATE INDEX idx_cart_items_customer_active ON public.cart_items(customer_id, cart_status);

-- ============================================================================
-- 7. ORDERS, ORDER ITEMS & SPLIT PURCHASE ORDERS
-- ============================================================================

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  delivery_address jsonb NOT NULL,
  notes text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  order_status text NOT NULL DEFAULT 'Pending' CHECK (
    order_status IN (
      'Pending',
      'Confirmed',
      'Processing',
      'Purchase Order Sent',
      'Manufacturer Fulfilment Pending',
      'Dispatched',
      'Out for Delivery',
      'Delivered',
      'Cancelled'
    )
  ),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid')),
  placed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_id ON public.orders(customer_id);
CREATE INDEX idx_orders_status ON public.orders(order_status);
CREATE INDEX idx_orders_placed_at ON public.orders(placed_at DESC);

-- Customer-visible order items (zero manufacturer or margin data)
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_name_snapshot text NOT NULL,
  sku_snapshot text NOT NULL,
  unit_snapshot text NOT NULL,
  hsn_snapshot text,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_selling_price numeric(12,2) NOT NULL CHECK (unit_selling_price >= 0),
  gst_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_items_order_id ON public.order_items(order_id);
CREATE INDEX idx_order_items_product_id ON public.order_items(product_id);

-- Admin-only financial snapshot per order item
CREATE TABLE public.order_item_financials (
  order_item_id uuid PRIMARY KEY REFERENCES public.order_items(id) ON DELETE CASCADE,
  manufacturer_id uuid NOT NULL REFERENCES public.manufacturers(id) ON DELETE RESTRICT,
  manufacturer_name_snapshot text NOT NULL,
  unit_manufacturer_price numeric(12,2) NOT NULL CHECK (unit_manufacturer_price >= 0),
  margin_percentage_snapshot numeric(7,2) NOT NULL DEFAULT 0,
  margin_amount_total numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_item_financials_manufacturer_id ON public.order_item_financials(manufacturer_id);

CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number text NOT NULL UNIQUE,
  manufacturer_id uuid NOT NULL REFERENCES public.manufacturers(id) ON DELETE RESTRICT,
  source_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'Draft' CHECK (
    status IN ('Draft', 'Sent to Manufacturer', 'Acknowledged', 'In Production', 'Dispatched', 'Received', 'Cancelled')
  ),
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  expected_delivery_date date,
  manufacturer_invoice_number text,
  manufacturer_invoice_date date,
  manufacturer_invoice_url text,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_orders_manufacturer_id ON public.purchase_orders(manufacturer_id);
CREATE INDEX idx_purchase_orders_source_order_id ON public.purchase_orders(source_order_id);
CREATE INDEX idx_purchase_orders_status ON public.purchase_orders(status);

CREATE TABLE public.purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES public.order_items(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_name_snapshot text NOT NULL,
  sku_snapshot text NOT NULL,
  unit_snapshot text NOT NULL,
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0),
  unit_manufacturer_price numeric(12,2) NOT NULL CHECK (unit_manufacturer_price >= 0),
  gst_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_po_items_purchase_order_id ON public.purchase_order_items(purchase_order_id);
CREATE INDEX idx_po_items_order_item_id ON public.purchase_order_items(order_item_id);

-- ============================================================================
-- 8. INVOICES, PAYMENTS, NOTIFICATIONS & AUDIT LOGS
-- ============================================================================

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL DEFAULT (CURRENT_DATE + 15),
  is_inter_state boolean NOT NULL DEFAULT false,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  cgst_amount numeric(14,2) NOT NULL DEFAULT 0,
  sgst_amount numeric(14,2) NOT NULL DEFAULT 0,
  igst_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_customer_id ON public.invoices(customer_id);
CREATE INDEX idx_invoices_payment_status ON public.invoices(payment_status);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('Bank Transfer', 'UPI', 'NEFT/RTGS', 'Cheque', 'Cash', 'Card')),
  reference_number text,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  recorded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_invoice_id ON public.payments(invoice_id);
CREATE INDEX idx_payments_customer_id ON public.payments(customer_id);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_role text CHECK (recipient_role IN ('admin', 'staff', 'customer')),
  recipient_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  entity_type text,
  entity_id uuid,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_recipient_user ON public.notifications(recipient_user_id, is_read);
CREATE INDEX idx_notifications_recipient_role ON public.notifications(recipient_role, is_read);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_entity ON public.audit_logs(entity_type, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON public.audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_product_prices_updated_by ON public.product_prices(updated_by);
CREATE INDEX idx_product_prices_approved_by ON public.product_prices(approved_by);
CREATE INDEX idx_price_history_changed_by ON public.price_history(changed_by);
CREATE INDEX idx_inventory_movements_created_by ON public.inventory_movements(created_by);
CREATE INDEX idx_customer_product_prices_updated_by ON public.customer_product_prices(updated_by);
CREATE INDEX idx_cart_items_product_id ON public.cart_items(product_id);
CREATE INDEX idx_purchase_orders_created_by ON public.purchase_orders(created_by);
CREATE INDEX idx_purchase_order_items_product_id ON public.purchase_order_items(product_id);
CREATE INDEX idx_invoices_created_by ON public.invoices(created_by);
CREATE INDEX idx_payments_recorded_by ON public.payments(recorded_by);
