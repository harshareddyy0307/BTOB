-- ============================================================================
-- Migration 010: Audit Security, Integrity, Rate-Limit, Category & Order Fixes
-- ============================================================================

-- 1. Canonical phone normalization & indexed unique lookup on customers
CREATE OR REPLACE FUNCTION private.canonical_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT CASE
    WHEN length(d) = 13 AND left(d, 3) = '091' THEN substr(d, 4)
    WHEN length(d) = 12 AND left(d, 2) = '91' THEN substr(d, 3)
    WHEN length(d) = 11 AND left(d, 1) = '0' THEN substr(d, 2)
    ELSE d
  END
  FROM (SELECT regexp_replace(p_phone, '[^0-9]', '', 'g') AS d) s;
$$;

GRANT EXECUTE ON FUNCTION private.canonical_phone(text) TO authenticated, service_role;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_canonical_phone
  ON public.customers (private.canonical_phone(phone))
  WHERE private.canonical_phone(phone) <> '';

CREATE OR REPLACE FUNCTION public.find_customers_by_canonical_phone(p_phone text)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  email text,
  phone text,
  status text,
  business_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.user_id, c.email, c.phone, c.status, c.business_name
  FROM public.customers c
  WHERE private.canonical_phone(c.phone) = private.canonical_phone(p_phone)
    AND private.canonical_phone(p_phone) <> '';
$$;

REVOKE ALL ON FUNCTION public.find_customers_by_canonical_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_customers_by_canonical_phone(text) TO service_role;

-- 2. Normalize account emails/usernames to lowercase & enforce case-insensitive uniqueness
UPDATE public.users
SET email = lower(trim(email))
WHERE email IS DISTINCT FROM lower(trim(email));

UPDATE public.users
SET username = NULLIF(lower(trim(username)), '')
WHERE username IS DISTINCT FROM NULLIF(lower(trim(username)), '');

UPDATE public.customers
SET email = lower(trim(email))
WHERE email IS DISTINCT FROM lower(trim(email));

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON public.users (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_email_lower
  ON public.customers (lower(email));

CREATE OR REPLACE FUNCTION private.normalize_user_identifiers()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email := lower(trim(COALESCE(NEW.email, '')));
  END IF;
  IF TG_OP = 'INSERT' OR NEW.username IS DISTINCT FROM OLD.username THEN
    NEW.username := NULLIF(lower(trim(COALESCE(NEW.username, ''))), '');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_01_normalize_user_identifiers
  BEFORE INSERT OR UPDATE OF email, username ON public.users
  FOR EACH ROW EXECUTE FUNCTION private.normalize_user_identifiers();

CREATE OR REPLACE FUNCTION private.normalize_customer_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email := lower(trim(COALESCE(NEW.email, '')));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_01_normalize_customer_email
  BEFORE INSERT OR UPDATE OF email ON public.customers
  FOR EACH ROW EXECUTE FUNCTION private.normalize_customer_email();

-- 3. Persistent auth/registration rate-limiting store (service_role only)
CREATE TABLE IF NOT EXISTS private.auth_rate_limits (
  bucket text NOT NULL,
  rate_key text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, rate_key)
);

REVOKE ALL ON TABLE private.auth_rate_limits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_auth_rate_limit(
  p_bucket text,
  p_key text,
  p_max_attempts integer,
  p_window_seconds integer
)
RETURNS TABLE (
  allowed boolean,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
  v_clean_bucket text := trim(COALESCE(p_bucket, 'default'));
  v_clean_key text := trim(COALESCE(p_key, 'unknown'));
  v_max integer := GREATEST(1, COALESCE(p_max_attempts, 10));
  v_win integer := GREATEST(10, COALESCE(p_window_seconds, 60));
BEGIN
  INSERT INTO private.auth_rate_limits AS rl (bucket, rate_key, window_started_at, attempt_count)
  VALUES (v_clean_bucket, v_clean_key, v_now, 1)
  ON CONFLICT (bucket, rate_key) DO UPDATE SET
    window_started_at = CASE
      WHEN rl.window_started_at <= (v_now - make_interval(secs => v_win)) THEN v_now
      ELSE rl.window_started_at
    END,
    attempt_count = CASE
      WHEN rl.window_started_at <= (v_now - make_interval(secs => v_win)) THEN 1
      ELSE rl.attempt_count + 1
    END
  RETURNING rl.window_started_at, rl.attempt_count INTO v_window_start, v_count;

  -- Opportunistic stale entry cleanup
  IF v_count = 1 THEN
    DELETE FROM private.auth_rate_limits
    WHERE window_started_at < (v_now - interval '24 hours');
  END IF;

  RETURN QUERY SELECT
    (v_count <= v_max) AS allowed,
    GREATEST(1, ceil(extract(epoch FROM ((v_window_start + make_interval(secs => v_win)) - v_now)))::integer) AS retry_after_seconds;
END;
$$;

REVOKE ALL ON FUNCTION public.check_auth_rate_limit(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_auth_rate_limit(text, text, integer, integer) TO service_role;

-- 4. Prevent cyclic category parent references at DB level
CREATE OR REPLACE FUNCTION private.prevent_category_cycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_has_cycle boolean := false;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'A category cannot be its own parent category';
  END IF;

  WITH RECURSIVE ancestor_chain AS (
    SELECT c.id, c.parent_id, ARRAY[NEW.id, c.id] AS visited
    FROM public.categories c
    WHERE c.id = NEW.parent_id
    UNION ALL
    SELECT parent.id, parent.parent_id, ac.visited || parent.id
    FROM ancestor_chain ac
    JOIN public.categories parent ON parent.id = ac.parent_id
    WHERE ac.parent_id IS NOT NULL
      AND NOT (parent.id = ANY(ac.visited))
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestor_chain ac WHERE ac.parent_id = NEW.id
  )
  INTO v_has_cycle;

  IF v_has_cycle THEN
    RAISE EXCEPTION 'Category hierarchy cannot contain a circular parent reference';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_prevent_category_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON public.categories
  FOR EACH ROW EXECUTE FUNCTION private.prevent_category_cycle();

-- 5. Partial unique index on active cart items & safe add_to_cart upsert
ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_customer_id_product_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_items_customer_product_active
  ON public.cart_items (customer_id, product_id)
  WHERE cart_status = 'active';

CREATE OR REPLACE FUNCTION public.add_to_cart(
  p_product_id uuid,
  p_quantity numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_customer public.customers%ROWTYPE;
  v_prod record;
  v_existing public.cart_items%ROWTYPE;
  v_final_qty numeric(12,2);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE user_id = v_user_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active customer profile required';
  END IF;

  SELECT
    p.id, p.name, p.min_order_quantity, p.is_published, p.status AS product_status,
    c.status AS category_status, m.status AS manufacturer_status,
    inv.available_quantity
  INTO v_prod
  FROM public.products p
  JOIN public.categories c ON c.id = p.category_id
  JOIN public.manufacturers m ON m.id = p.manufacturer_id
  JOIN public.inventory inv ON inv.product_id = p.id
  WHERE p.id = p_product_id;

  IF NOT FOUND OR v_prod.is_published = false OR v_prod.product_status <> 'active'
     OR v_prod.category_status <> 'active' OR v_prod.manufacturer_status <> 'active' THEN
    RAISE EXCEPTION 'Product is unavailable';
  END IF;

  SELECT * INTO v_existing
  FROM public.cart_items
  WHERE customer_id = v_customer.id
    AND product_id = p_product_id
    AND cart_status = 'active';

  IF FOUND THEN
    v_final_qty := v_existing.quantity + p_quantity;
  ELSE
    v_final_qty := p_quantity;
  END IF;

  IF v_final_qty < v_prod.min_order_quantity THEN
    RAISE EXCEPTION 'Minimum order quantity for "%" is %', v_prod.name, v_prod.min_order_quantity;
  END IF;

  IF v_final_qty > v_prod.available_quantity THEN
    RAISE EXCEPTION 'Only % units available in stock for "%"', v_prod.available_quantity, v_prod.name;
  END IF;

  INSERT INTO public.cart_items (customer_id, product_id, quantity, cart_status, order_id)
  VALUES (v_customer.id, p_product_id, v_final_qty, 'active', NULL)
  ON CONFLICT (customer_id, product_id) WHERE cart_status = 'active' DO UPDATE SET
    quantity = EXCLUDED.quantity,
    updated_at = now();

  RETURN v_final_qty;
END;
$$;

REVOKE ALL ON FUNCTION public.add_to_cart(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_to_cart(uuid, numeric) TO authenticated;

-- 6. Guard generate_customer_invoice and split_order_to_purchase_orders against cancelled records
CREATE OR REPLACE FUNCTION public.generate_customer_invoice(
  p_order_id uuid,
  p_due_days integer DEFAULT 15
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_existing_id uuid;
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_agency public.agency_settings%ROWTYPE;
  v_is_inter_state boolean;
  v_cgst numeric(14,2) := 0;
  v_sgst numeric(14,2) := 0;
  v_igst numeric(14,2) := 0;
  v_inv_number text;
  v_inv_id uuid;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_existing_id FROM public.invoices WHERE order_id = p_order_id;
  IF FOUND THEN
    RETURN v_existing_id;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.order_status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot generate invoice for a cancelled order';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE id = v_order.customer_id;
  SELECT * INTO v_agency FROM public.agency_settings WHERE id = 1;

  v_is_inter_state := lower(trim(COALESCE(v_order.delivery_address->>'state', v_customer.state))) <> lower(trim(COALESCE(v_agency.state, '')));

  IF v_is_inter_state THEN
    v_igst := v_order.tax_total;
  ELSE
    v_cgst := ROUND(v_order.tax_total / 2.0, 2);
    v_sgst := v_order.tax_total - v_cgst;
  END IF;

  v_inv_number := COALESCE(v_agency.invoice_prefix, 'INV') || '-' || to_char(now(), 'YYYY') || '-' || nextval('public.invoice_number_seq');

  INSERT INTO public.invoices (
    invoice_number, order_id, customer_id, invoice_date, due_date,
    is_inter_state, subtotal, cgst_amount, sgst_amount, igst_amount,
    tax_total, total_amount, paid_amount, payment_status, created_by
  )
  VALUES (
    v_inv_number, p_order_id, v_order.customer_id, CURRENT_DATE, CURRENT_DATE + p_due_days,
    v_is_inter_state, v_order.subtotal, v_cgst, v_sgst, v_igst,
    v_order.tax_total, v_order.total_amount, v_order.paid_amount, v_order.payment_status, v_actor
  )
  RETURNING id INTO v_inv_id;

  IF v_customer.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_role, recipient_user_id, title, message, entity_type, entity_id)
    VALUES (
      'customer',
      v_customer.user_id,
      'Tax Invoice Generated: ' || v_inv_number,
      'Invoice ' || v_inv_number || ' for order ' || v_order.order_number || ' (₹' || v_order.total_amount::text || ') is ready.',
      'invoice',
      v_inv_id
    );
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (v_actor, 'generate_invoice', 'invoices', v_inv_id::text, jsonb_build_object('invoice_number', v_inv_number, 'order_id', p_order_id));

  RETURN v_inv_id;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_customer_invoice(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_invoice(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.split_order_to_purchase_orders(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_order public.orders%ROWTYPE;
  v_mfg record;
  v_item record;
  v_po_id uuid;
  v_po_number text;
  v_po_prefix text;
  v_sub numeric(14,2);
  v_tax numeric(14,2);
  v_tot numeric(14,2);
  v_line_sub numeric(14,2);
  v_line_tax numeric(12,2);
  v_line_tot numeric(14,2);
  v_created_pos jsonb := '[]'::jsonb;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.order_status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot split a cancelled order into purchase orders';
  END IF;

  SELECT po_prefix INTO v_po_prefix FROM public.agency_settings WHERE id = 1;

  FOR v_mfg IN
    SELECT DISTINCT oif.manufacturer_id, oif.manufacturer_name_snapshot
    FROM public.order_items oi
    JOIN public.order_item_financials oif ON oif.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.purchase_order_items poi
        JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
        WHERE poi.order_item_id = oi.id
          AND po.status <> 'Cancelled'
      )
  LOOP
    v_po_number := COALESCE(v_po_prefix, 'PO') || '-' || to_char(now(), 'YYYYMMDD') || '-' || nextval('public.po_number_seq');
    v_sub := 0; v_tax := 0; v_tot := 0;

    INSERT INTO public.purchase_orders (
      po_number, manufacturer_id, source_order_id, status, notes, created_by
    )
    VALUES (
      v_po_number, v_mfg.manufacturer_id, p_order_id, 'Draft',
      'Auto-generated from Customer Order ' || v_order.order_number, v_actor
    )
    RETURNING id INTO v_po_id;

    FOR v_item IN
      SELECT
        oi.*,
        oif.unit_manufacturer_price
      FROM public.order_items oi
      JOIN public.order_item_financials oif ON oif.order_item_id = oi.id
      WHERE oi.order_id = p_order_id
        AND oif.manufacturer_id = v_mfg.manufacturer_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.purchase_order_items poi
          JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
          WHERE poi.order_item_id = oi.id
            AND po.status <> 'Cancelled'
        )
    LOOP
      v_line_sub := ROUND(v_item.unit_manufacturer_price * v_item.quantity, 2);
      v_line_tax := ROUND(v_line_sub * v_item.gst_rate / 100.0, 2);
      v_line_tot := ROUND(v_line_sub + v_line_tax, 2);
      v_sub := v_sub + v_line_sub;
      v_tax := v_tax + v_line_tax;
      v_tot := v_tot + v_line_tot;

      INSERT INTO public.purchase_order_items (
        purchase_order_id, order_item_id, product_id, product_name_snapshot,
        sku_snapshot, unit_snapshot, quantity, unit_manufacturer_price, gst_rate, tax_amount, line_total
      )
      VALUES (
        v_po_id, v_item.id, v_item.product_id, v_item.product_name_snapshot,
        v_item.sku_snapshot, v_item.unit_snapshot, v_item.quantity,
        v_item.unit_manufacturer_price, v_item.gst_rate, v_line_tax, v_line_tot
      );
    END LOOP;

    UPDATE public.purchase_orders SET
      subtotal = v_sub,
      tax_total = v_tax,
      total_amount = v_tot
    WHERE id = v_po_id;

    v_created_pos := v_created_pos || jsonb_build_object('po_id', v_po_id, 'po_number', v_po_number, 'manufacturer_name', v_mfg.manufacturer_name_snapshot, 'total_amount', v_tot);
  END LOOP;

  IF jsonb_array_length(v_created_pos) > 0 AND v_order.order_status IN ('Pending', 'Confirmed', 'Processing') THEN
    UPDATE public.orders SET order_status = 'Purchase Order Sent' WHERE id = p_order_id;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (v_actor, 'split_order_to_pos', 'orders', p_order_id::text, jsonb_build_object('created_pos', v_created_pos));

  RETURN v_created_pos;
END;
$$;

REVOKE ALL ON FUNCTION public.split_order_to_purchase_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_order_to_purchase_orders(uuid) TO authenticated;

-- 7. Atomic admin stock delta + alert threshold RPC (logs inventory_movements & audit_logs)
CREATE OR REPLACE FUNCTION public.adjust_product_stock_and_threshold_admin(
  p_product_id uuid,
  p_quantity_delta numeric,
  p_low_stock_threshold numeric,
  p_movement_type text DEFAULT 'manual_adjustment',
  p_notes text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_inv public.inventory%ROWTYPE;
  v_delta numeric(12,2) := ROUND(COALESCE(p_quantity_delta, 0), 2);
  v_threshold numeric(12,2) := GREATEST(0, ROUND(COALESCE(p_low_stock_threshold, 10), 2));
  v_new_balance numeric(12,2);
  v_move_type text := COALESCE(NULLIF(trim(p_movement_type), ''), 'manual_adjustment');
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF v_move_type NOT IN ('restock', 'manual_adjustment') THEN
    v_move_type := 'manual_adjustment';
  END IF;

  INSERT INTO public.inventory (product_id, available_quantity, low_stock_threshold)
  VALUES (p_product_id, 0, v_threshold)
  ON CONFLICT (product_id) DO NOTHING;

  SELECT * INTO v_inv FROM public.inventory WHERE product_id = p_product_id FOR UPDATE;
  v_new_balance := ROUND(v_inv.available_quantity + v_delta, 2);

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'Invalid stock adjustment: resulting available stock cannot be negative';
  END IF;

  UPDATE public.inventory
  SET
    available_quantity = v_new_balance,
    low_stock_threshold = v_threshold
  WHERE product_id = p_product_id;

  IF v_delta <> 0 THEN
    INSERT INTO public.inventory_movements (
      product_id, movement_type, quantity_delta, balance_after, reference_type, notes, created_by
    )
    VALUES (
      p_product_id,
      v_move_type,
      v_delta,
      v_new_balance,
      'manual',
      COALESCE(NULLIF(trim(p_notes), ''), 'Updated from product editor'),
      v_actor
    );

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data, new_data)
    VALUES (
      v_actor,
      'adjust_inventory',
      'inventory',
      p_product_id::text,
      jsonb_build_object('available_quantity', v_inv.available_quantity, 'low_stock_threshold', v_inv.low_stock_threshold),
      jsonb_build_object('delta', v_delta, 'balance_after', v_new_balance, 'low_stock_threshold', v_threshold, 'notes', p_notes)
    );
  END IF;

  RETURN v_new_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_product_stock_and_threshold_admin(uuid, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_product_stock_and_threshold_admin(uuid, numeric, numeric, text, text) TO authenticated;

-- 8. Customer self-profile contact update RPC (syncs customers & users + validates phone uniqueness)
CREATE OR REPLACE FUNCTION public.update_own_customer_profile(
  p_owner_name text,
  p_phone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_customer public.customers%ROWTYPE;
  v_clean_owner text := trim(COALESCE(p_owner_name, ''));
  v_clean_phone text := trim(COALESCE(p_phone, ''));
  v_canon text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_customer
  FROM public.customers
  WHERE user_id = v_user_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active customer business profile required';
  END IF;

  IF length(v_clean_owner) < 2 OR length(v_clean_owner) > 120 THEN
    RAISE EXCEPTION 'Authorized contact name must be between 2 and 120 characters';
  END IF;

  v_canon := private.canonical_phone(v_clean_phone);
  IF length(v_canon) < 7 OR length(v_canon) > 15 THEN
    RAISE EXCEPTION 'Enter a valid phone number';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.id <> v_customer.id
      AND private.canonical_phone(c.phone) = v_canon
  ) THEN
    RAISE EXCEPTION 'This phone number is already associated with another business account';
  END IF;

  UPDATE public.customers
  SET owner_name = v_clean_owner, phone = v_clean_phone
  WHERE id = v_customer.id;

  UPDATE public.users
  SET full_name = v_clean_owner, phone = v_clean_phone
  WHERE id = v_user_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_user_id,
    'customer_update_own_profile',
    'customers',
    v_customer.id::text,
    jsonb_build_object('owner_name', v_customer.owner_name, 'phone', v_customer.phone),
    jsonb_build_object('owner_name', v_clean_owner, 'phone', v_clean_phone)
  );

  RETURN jsonb_build_object('owner_name', v_clean_owner, 'phone', v_clean_phone);
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_customer_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_own_customer_profile(text, text) TO authenticated;
