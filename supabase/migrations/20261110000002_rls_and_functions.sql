-- ============================================================================
-- Migration 002: Security Helpers, Triggers, Catalog Sync, RPCs & Strict RLS
-- ============================================================================

-- ============================================================================
-- 1. PRIVATE HELPER FUNCTIONS (Non-exposed schema, search_path pinned)
-- ============================================================================

CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.name
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
  WHERE u.id = (SELECT auth.uid())
    AND u.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.is_admin_or_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(private.current_user_role() IN ('admin', 'staff'), false);
$$;

CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(private.current_user_role() = 'admin', false);
$$;

CREATE OR REPLACE FUNCTION private.is_active_customer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.customers c
    JOIN public.users u ON u.id = c.user_id
    WHERE c.user_id = (SELECT auth.uid())
      AND u.is_active = true
      AND c.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION private.current_customer_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id
  FROM public.customers c
  WHERE c.user_id = (SELECT auth.uid())
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION private.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_admin_or_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_active_customer() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_customer_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_branding()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'agency_name', COALESCE((SELECT agency_name FROM public.agency_settings WHERE id = 1), 'TradeBridge B2B'),
    'logo_url', (SELECT logo_url FROM public.agency_settings WHERE id = 1),
    'currency_symbol', COALESCE((SELECT currency_symbol FROM public.agency_settings WHERE id = 1), '₹'),
    'has_admin', EXISTS (
      SELECT 1 FROM public.users u
      JOIN public.roles r ON r.id = u.role_id
      WHERE r.name = 'admin' AND u.is_active = true
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_public_branding() TO anon, authenticated;

-- ============================================================================
-- 2. UPDATED_AT TRIGGERS
-- ============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'agency_settings', 'categories', 'manufacturers',
    'products', 'margin_rules', 'product_prices', 'inventory',
    'customers', 'customer_product_prices', 'published_catalog',
    'cart_items', 'orders', 'purchase_orders', 'invoices'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================================
-- 3. PUBLISHED CATALOG SYNC ENGINE (Zero supplier/margin leakage)
-- ============================================================================

CREATE OR REPLACE FUNCTION private.sync_published_catalog_for_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prod record;
  v_price record;
  v_inv record;
  v_primary_img text;
  v_images jsonb;
  v_stock_status text;
  v_should_publish boolean;
BEGIN
  SELECT p.* INTO v_prod
  FROM public.products p
  WHERE p.id = p_product_id;

  IF NOT FOUND THEN
    DELETE FROM public.published_catalog WHERE product_id = p_product_id;
    RETURN;
  END IF;

  SELECT * INTO v_price FROM public.product_prices WHERE product_id = p_product_id;
  SELECT * INTO v_inv FROM public.inventory WHERE product_id = p_product_id;

  SELECT pi.image_url INTO v_primary_img
  FROM public.product_images pi
  WHERE pi.product_id = p_product_id
  ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.created_at ASC
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(pi.image_url ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.created_at ASC), '[]'::jsonb)
  INTO v_images
  FROM public.product_images pi
  WHERE pi.product_id = p_product_id;

  IF COALESCE(v_inv.available_quantity, 0) <= 0 THEN
    v_stock_status := 'out_of_stock';
  ELSIF v_inv.available_quantity <= COALESCE(v_inv.low_stock_threshold, 10) THEN
    v_stock_status := 'low_stock';
  ELSE
    v_stock_status := 'in_stock';
  END IF;

  v_should_publish := (
    v_prod.is_published = true
    AND v_prod.status = 'active'
    AND EXISTS (SELECT 1 FROM public.categories c WHERE c.id = v_prod.category_id AND c.status = 'active')
    AND EXISTS (SELECT 1 FROM public.manufacturers m WHERE m.id = v_prod.manufacturer_id AND m.status = 'active')
    AND COALESCE(v_price.published_selling_price, 0) > 0
  );

  INSERT INTO public.published_catalog (
    product_id, category_id, name, sku, description, unit_of_measurement,
    min_order_quantity, hsn_code, gst_rate, selling_price,
    available_quantity, stock_status, primary_image_url, image_urls,
    is_featured, is_published, created_at, updated_at
  )
  VALUES (
    v_prod.id,
    v_prod.category_id,
    v_prod.name,
    v_prod.sku,
    v_prod.description,
    v_prod.unit_of_measurement,
    v_prod.min_order_quantity,
    v_prod.hsn_code,
    v_prod.gst_rate,
    COALESCE(v_price.published_selling_price, 0),
    COALESCE(v_inv.available_quantity, 0),
    v_stock_status,
    v_primary_img,
    v_images,
    v_prod.is_featured,
    v_should_publish,
    v_prod.created_at,
    now()
  )
  ON CONFLICT (product_id) DO UPDATE SET
    category_id = EXCLUDED.category_id,
    name = EXCLUDED.name,
    sku = EXCLUDED.sku,
    description = EXCLUDED.description,
    unit_of_measurement = EXCLUDED.unit_of_measurement,
    min_order_quantity = EXCLUDED.min_order_quantity,
    hsn_code = EXCLUDED.hsn_code,
    gst_rate = EXCLUDED.gst_rate,
    selling_price = EXCLUDED.selling_price,
    available_quantity = EXCLUDED.available_quantity,
    stock_status = EXCLUDED.stock_status,
    primary_image_url = EXCLUDED.primary_image_url,
    image_urls = EXCLUDED.image_urls,
    is_featured = EXCLUDED.is_featured,
    is_published = EXCLUDED.is_published,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION private.trg_sync_catalog_from_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.published_catalog WHERE product_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM private.sync_published_catalog_for_product(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.trg_sync_catalog_from_child()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.product_id, OLD.product_id);
  PERFORM private.sync_published_catalog_for_product(v_pid);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION private.trg_sync_catalog_from_manufacturer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pid uuid;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_pid IN SELECT id FROM public.products WHERE manufacturer_id = NEW.id LOOP
      PERFORM private.sync_published_catalog_for_product(v_pid);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.trg_sync_catalog_from_category()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pid uuid;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    FOR v_pid IN SELECT id FROM public.products WHERE category_id = NEW.id LOOP
      PERFORM private.sync_published_catalog_for_product(v_pid);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_sync_catalog
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_product();

CREATE TRIGGER trg_product_prices_sync_catalog
  AFTER INSERT OR UPDATE OR DELETE ON public.product_prices
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_child();

CREATE TRIGGER trg_inventory_sync_catalog
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_child();

CREATE TRIGGER trg_product_images_sync_catalog
  AFTER INSERT OR UPDATE OR DELETE ON public.product_images
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_child();

CREATE TRIGGER trg_manufacturers_sync_catalog
  AFTER UPDATE OF status ON public.manufacturers
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_manufacturer();

CREATE TRIGGER trg_categories_sync_catalog
  AFTER UPDATE OF status ON public.categories
  FOR EACH ROW EXECUTE FUNCTION private.trg_sync_catalog_from_category();

-- Customer-facing view with security_invoker = true (zero Security Advisor warnings!)
CREATE OR REPLACE VIEW public.v_customer_catalog
WITH (security_invoker = true) AS
SELECT
  pc.product_id AS id,
  pc.category_id,
  c.name AS category_name,
  c.slug AS category_slug,
  pc.name,
  pc.sku,
  pc.description,
  pc.unit_of_measurement,
  pc.min_order_quantity,
  pc.hsn_code,
  pc.gst_rate,
  COALESCE(cpp.custom_selling_price, pc.selling_price) AS selling_price,
  (cpp.custom_selling_price IS NOT NULL) AS has_custom_price,
  pc.available_quantity,
  pc.stock_status,
  pc.primary_image_url,
  pc.image_urls,
  pc.is_featured,
  pc.created_at,
  pc.updated_at
FROM public.published_catalog pc
JOIN public.categories c ON c.id = pc.category_id
LEFT JOIN public.customer_product_prices cpp
  ON cpp.product_id = pc.product_id
  AND cpp.customer_id = private.current_customer_id()
  AND cpp.is_active = true
WHERE pc.is_published = true;

GRANT SELECT ON public.v_customer_catalog TO authenticated;

-- ============================================================================
-- 4. PRICING & MARGIN ENGINE RPCs (Individual > Category > Global)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_effective_margin(p_product_id uuid)
RETURNS TABLE (margin_source text, margin_percentage numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cat_id uuid;
  v_parent_cat_id uuid;
  v_pct numeric;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- 1. Product-level margin
  SELECT mr.margin_percentage INTO v_pct
  FROM public.margin_rules mr
  WHERE mr.scope = 'product' AND mr.product_id = p_product_id AND mr.is_active = true
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT 'product'::text, v_pct;
    RETURN;
  END IF;

  -- 2. Category-level margin (including direct parent category fallback)
  SELECT p.category_id INTO v_cat_id FROM public.products p WHERE p.id = p_product_id;
  IF v_cat_id IS NOT NULL THEN
    SELECT mr.margin_percentage INTO v_pct
    FROM public.margin_rules mr
    WHERE mr.scope = 'category' AND mr.category_id = v_cat_id AND mr.is_active = true
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT 'category'::text, v_pct;
      RETURN;
    END IF;

    SELECT c.parent_id INTO v_parent_cat_id FROM public.categories c WHERE c.id = v_cat_id;
    IF v_parent_cat_id IS NOT NULL THEN
      SELECT mr.margin_percentage INTO v_pct
      FROM public.margin_rules mr
      WHERE mr.scope = 'category' AND mr.category_id = v_parent_cat_id AND mr.is_active = true
      LIMIT 1;

      IF FOUND THEN
        RETURN QUERY SELECT 'category'::text, v_pct;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- 3. Global margin
  SELECT mr.margin_percentage INTO v_pct
  FROM public.margin_rules mr
  WHERE mr.scope = 'global' AND mr.is_active = true
  LIMIT 1;

  RETURN QUERY SELECT 'global'::text, COALESCE(v_pct, 15.00);
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_product_draft_price(
  p_product_id uuid,
  p_new_manufacturer_price numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_existing public.product_prices%ROWTYPE;
  v_mfg_price numeric(12,2);
  v_eff record;
  v_margin_amt numeric(12,2);
  v_selling numeric(12,2);
  v_status text;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_existing FROM public.product_prices WHERE product_id = p_product_id;
  v_mfg_price := COALESCE(p_new_manufacturer_price, v_existing.draft_manufacturer_price, 0);

  SELECT * INTO v_eff FROM public.resolve_effective_margin(p_product_id);
  v_margin_amt := ROUND(v_mfg_price * v_eff.margin_percentage / 100.0, 2);
  v_selling := ROUND(v_mfg_price + v_margin_amt, 2);

  IF v_existing.product_id IS NULL THEN
    INSERT INTO public.product_prices (
      product_id,
      published_manufacturer_price, published_margin_source, published_margin_percentage,
      published_margin_amount, published_selling_price, published_at,
      draft_manufacturer_price, draft_margin_source, draft_margin_percentage,
      draft_margin_amount, draft_selling_price, approval_status, updated_by
    )
    VALUES (
      p_product_id,
      0, 'global', 0, 0, 0, NULL,
      v_mfg_price, v_eff.margin_source, v_eff.margin_percentage,
      v_margin_amt, v_selling, 'pending_review', v_actor
    );
  ELSE
    IF v_existing.published_selling_price = v_selling
       AND v_existing.published_manufacturer_price = v_mfg_price
       AND v_existing.published_margin_percentage = v_eff.margin_percentage THEN
      v_status := 'published';
    ELSE
      v_status := 'pending_review';
    END IF;

    UPDATE public.product_prices SET
      draft_manufacturer_price = v_mfg_price,
      draft_margin_source = v_eff.margin_source,
      draft_margin_percentage = v_eff.margin_percentage,
      draft_margin_amount = v_margin_amt,
      draft_selling_price = v_selling,
      approval_status = v_status,
      updated_by = v_actor
    WHERE product_id = p_product_id;
  END IF;

  INSERT INTO public.price_history (
    product_id, old_manufacturer_price, new_manufacturer_price,
    old_margin_percentage, new_margin_percentage,
    old_selling_price, new_selling_price, action, notes, changed_by
  )
  VALUES (
    p_product_id,
    v_existing.draft_manufacturer_price,
    v_mfg_price,
    v_existing.draft_margin_percentage,
    v_eff.margin_percentage,
    v_existing.draft_selling_price,
    v_selling,
    'draft_calculated',
    COALESCE(p_notes, 'Margin/manufacturer price recalculated'),
    v_actor
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_product_prices(
  p_product_ids uuid[],
  p_mark_products_published boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_pid uuid;
  v_price public.product_prices%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  FOREACH v_pid IN ARRAY p_product_ids LOOP
    SELECT * INTO v_price FROM public.product_prices WHERE product_id = v_pid;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.product_prices SET
      published_manufacturer_price = v_price.draft_manufacturer_price,
      published_margin_source = v_price.draft_margin_source,
      published_margin_percentage = v_price.draft_margin_percentage,
      published_margin_amount = v_price.draft_margin_amount,
      published_selling_price = v_price.draft_selling_price,
      published_at = now(),
      approval_status = 'published',
      approved_by = v_actor
    WHERE product_id = v_pid;

    IF p_mark_products_published THEN
      UPDATE public.products SET is_published = true WHERE id = v_pid;
    END IF;

    INSERT INTO public.price_history (
      product_id, old_manufacturer_price, new_manufacturer_price,
      old_margin_percentage, new_margin_percentage,
      old_selling_price, new_selling_price, action, notes, changed_by
    )
    VALUES (
      v_pid,
      v_price.published_manufacturer_price,
      v_price.draft_manufacturer_price,
      v_price.published_margin_percentage,
      v_price.draft_margin_percentage,
      v_price.published_selling_price,
      v_price.draft_selling_price,
      'approved_published',
      'Published to customer catalog',
      v_actor
    );

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (v_actor, 'publish_prices', 'product_prices', array_to_string(p_product_ids, ','), jsonb_build_object('count', v_count));

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_margin_rule_and_recalculate(
  p_scope text,
  p_margin_percentage numeric,
  p_category_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_rule_id uuid;
  v_pid uuid;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_scope = 'global' THEN
    UPDATE public.margin_rules SET is_active = false WHERE scope = 'global' AND is_active = true;
  ELSIF p_scope = 'category' THEN
    UPDATE public.margin_rules SET is_active = false WHERE scope = 'category' AND category_id = p_category_id AND is_active = true;
  ELSIF p_scope = 'product' THEN
    UPDATE public.margin_rules SET is_active = false WHERE scope = 'product' AND product_id = p_product_id AND is_active = true;
  ELSE
    RAISE EXCEPTION 'Invalid margin scope: %', p_scope;
  END IF;

  INSERT INTO public.margin_rules (scope, category_id, product_id, margin_percentage, is_active, notes, updated_by)
  VALUES (p_scope, p_category_id, p_product_id, p_margin_percentage, true, p_notes, v_actor)
  RETURNING id INTO v_rule_id;

  IF p_scope = 'product' THEN
    PERFORM public.recalculate_product_draft_price(p_product_id, NULL, 'Product margin rule updated');
  ELSIF p_scope = 'category' THEN
    FOR v_pid IN
      SELECT p.id FROM public.products p
      LEFT JOIN public.categories c ON c.id = p.category_id
      WHERE p.category_id = p_category_id OR c.parent_id = p_category_id
    LOOP
      PERFORM public.recalculate_product_draft_price(v_pid, NULL, 'Category margin rule updated');
    END LOOP;
  ELSE
    FOR v_pid IN SELECT id FROM public.products LOOP
      PERFORM public.recalculate_product_draft_price(v_pid, NULL, 'Global margin rule updated');
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_actor, 'upsert_margin_rule', 'margin_rules', v_rule_id::text,
    jsonb_build_object('scope', p_scope, 'category_id', p_category_id, 'product_id', p_product_id, 'margin_percentage', p_margin_percentage)
  );

  RETURN v_rule_id;
END;
$$;

-- ============================================================================
-- 5. ATOMIC ORDER PLACEMENT, FULFILMENT, SPLIT POs, INVENTORY & INVOICING RPCs
-- ============================================================================

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
  WHERE customer_id = v_customer.id AND product_id = p_product_id;

  IF FOUND AND v_existing.cart_status = 'active' THEN
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
  ON CONFLICT (customer_id, product_id) DO UPDATE SET
    quantity = EXCLUDED.quantity,
    cart_status = 'active',
    order_id = NULL,
    updated_at = now();

  RETURN v_final_qty;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_customer_order(
  p_delivery_address jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_customer public.customers%ROWTYPE;
  v_cart_count integer;
  v_item record;
  v_selling_price numeric(12,2);
  v_line_subtotal numeric(14,2);
  v_line_tax numeric(14,2);
  v_line_total numeric(14,2);
  v_subtotal numeric(14,2) := 0;
  v_tax_total numeric(14,2) := 0;
  v_total_amount numeric(14,2) := 0;
  v_order_id uuid;
  v_order_number text;
  v_order_prefix text;
  v_order_item_id uuid;
  v_new_available numeric(12,2);
  v_margin_total numeric(14,2);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.user_id = v_user_id AND c.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active customer business profile required';
  END IF;

  SELECT COUNT(*) INTO v_cart_count FROM public.cart_items WHERE customer_id = v_customer.id AND cart_status = 'active';
  IF v_cart_count = 0 THEN
    RAISE EXCEPTION 'Your cart is empty';
  END IF;

  SELECT order_prefix INTO v_order_prefix FROM public.agency_settings WHERE id = 1;
  v_order_number := COALESCE(v_order_prefix, 'ORD') || '-' || to_char(now(), 'YYYYMMDD') || '-' || nextval('public.order_number_seq');

  INSERT INTO public.orders (order_number, customer_id, delivery_address, notes, order_status, payment_status)
  VALUES (v_order_number, v_customer.id, p_delivery_address, p_notes, 'Pending', 'unpaid')
  RETURNING id INTO v_order_id;

  FOR v_item IN
    SELECT
      ci.id AS cart_item_id,
      ci.quantity,
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      p.unit_of_measurement,
      p.hsn_code,
      p.gst_rate,
      p.min_order_quantity,
      p.is_published,
      p.status AS product_status,
      c.status AS category_status,
      p.manufacturer_id,
      m.company_name AS manufacturer_name,
      m.status AS manufacturer_status,
      pp.published_manufacturer_price,
      pp.published_margin_percentage,
      pp.published_selling_price,
      cpp.custom_selling_price,
      inv.available_quantity
    FROM public.cart_items ci
    JOIN public.products p ON p.id = ci.product_id
    JOIN public.categories c ON c.id = p.category_id
    JOIN public.manufacturers m ON m.id = p.manufacturer_id
    JOIN public.product_prices pp ON pp.product_id = p.id
    JOIN public.inventory inv ON inv.product_id = p.id
    LEFT JOIN public.customer_product_prices cpp
      ON cpp.customer_id = v_customer.id AND cpp.product_id = p.id AND cpp.is_active = true
    WHERE ci.customer_id = v_customer.id
      AND ci.cart_status = 'active'
    FOR UPDATE OF inv
  LOOP
    IF v_item.is_published = false OR v_item.product_status <> 'active' OR v_item.category_status <> 'active' OR v_item.manufacturer_status <> 'active' THEN
      RAISE EXCEPTION 'Product "%" is no longer available', v_item.product_name;
    END IF;

    IF v_item.quantity < v_item.min_order_quantity THEN
      RAISE EXCEPTION 'Product "%" requires minimum order quantity of %', v_item.product_name, v_item.min_order_quantity;
    END IF;

    IF v_item.available_quantity < v_item.quantity THEN
      RAISE EXCEPTION 'Insufficient stock for "%" (available: %, requested: %)', v_item.product_name, v_item.available_quantity, v_item.quantity;
    END IF;

    v_selling_price := COALESCE(v_item.custom_selling_price, v_item.published_selling_price);
    IF COALESCE(v_selling_price, 0) <= 0 THEN
      RAISE EXCEPTION 'Product "%" does not have an active selling price', v_item.product_name;
    END IF;

    v_line_subtotal := ROUND(v_selling_price * v_item.quantity, 2);
    v_line_tax := ROUND(v_line_subtotal * v_item.gst_rate / 100.0, 2);
    v_line_total := ROUND(v_line_subtotal + v_line_tax, 2);

    v_subtotal := v_subtotal + v_line_subtotal;
    v_tax_total := v_tax_total + v_line_tax;
    v_total_amount := v_total_amount + v_line_total;

    INSERT INTO public.order_items (
      order_id, product_id, product_name_snapshot, sku_snapshot, unit_snapshot,
      hsn_snapshot, quantity, unit_selling_price, gst_rate, tax_amount, line_total
    )
    VALUES (
      v_order_id, v_item.product_id, v_item.product_name, v_item.sku, v_item.unit_of_measurement,
      v_item.hsn_code, v_item.quantity, v_selling_price, v_item.gst_rate, v_line_tax, v_line_total
    )
    RETURNING id INTO v_order_item_id;

    v_margin_total := ROUND((v_selling_price - v_item.published_manufacturer_price) * v_item.quantity, 2);

    INSERT INTO public.order_item_financials (
      order_item_id, manufacturer_id, manufacturer_name_snapshot,
      unit_manufacturer_price, margin_percentage_snapshot, margin_amount_total
    )
    VALUES (
      v_order_item_id, v_item.manufacturer_id, v_item.manufacturer_name,
      v_item.published_manufacturer_price, v_item.published_margin_percentage, v_margin_total
    );

    v_new_available := v_item.available_quantity - v_item.quantity;

    UPDATE public.inventory SET
      available_quantity = v_new_available,
      reserved_quantity = reserved_quantity + v_item.quantity
    WHERE product_id = v_item.product_id;

    INSERT INTO public.inventory_movements (
      product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, notes, created_by
    )
    VALUES (
      v_item.product_id, 'order_reserved', -v_item.quantity, v_new_available,
      'order', v_order_id, 'Stock reserved for order ' || v_order_number, v_user_id
    );
  END LOOP;

  UPDATE public.orders SET
    subtotal = v_subtotal,
    tax_total = v_tax_total,
    total_amount = v_total_amount
  WHERE id = v_order_id;

  UPDATE public.cart_items SET
    cart_status = 'ordered',
    order_id = v_order_id,
    updated_at = now()
  WHERE customer_id = v_customer.id AND cart_status = 'active';

  INSERT INTO public.notifications (recipient_role, title, message, entity_type, entity_id)
  VALUES (
    'admin',
    'New B2B Order Received',
    v_customer.business_name || ' placed order ' || v_order_number || ' totaling ₹' || v_total_amount::text,
    'order',
    v_order_id
  );

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_user_id, 'place_order', 'orders', v_order_id::text,
    jsonb_build_object('order_number', v_order_number, 'customer_id', v_customer.id, 'total_amount', v_total_amount)
  );

  RETURN jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number, 'total_amount', v_total_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_order_status_admin(
  p_order_id uuid,
  p_new_status text,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_order public.orders%ROWTYPE;
  v_item record;
  v_cust_user_id uuid;
  v_new_avail numeric(12,2);
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.order_status = p_new_status THEN
    RETURN;
  END IF;

  IF v_order.order_status IN ('Delivered', 'Cancelled') THEN
    RAISE EXCEPTION 'Cannot change status of a % order', v_order.order_status;
  END IF;

  IF p_new_status = 'Delivered' THEN
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      UPDATE public.inventory SET
        reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity),
        sold_quantity = sold_quantity + v_item.quantity
      WHERE product_id = v_item.product_id
      RETURNING available_quantity INTO v_new_avail;

      INSERT INTO public.inventory_movements (
        product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, notes, created_by
      )
      VALUES (
        v_item.product_id, 'order_sold', 0, COALESCE(v_new_avail, 0),
        'order', p_order_id, 'Order ' || v_order.order_number || ' delivered', v_actor
      );
    END LOOP;
  ELSIF p_new_status = 'Cancelled' THEN
    FOR v_item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
      UPDATE public.inventory SET
        available_quantity = available_quantity + v_item.quantity,
        reserved_quantity = GREATEST(0, reserved_quantity - v_item.quantity)
      WHERE product_id = v_item.product_id
      RETURNING available_quantity INTO v_new_avail;

      INSERT INTO public.inventory_movements (
        product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, notes, created_by
      )
      VALUES (
        v_item.product_id, 'order_released', v_item.quantity, COALESCE(v_new_avail, 0),
        'order', p_order_id, 'Reserved stock released on cancellation of ' || v_order.order_number, v_actor
      );
    END LOOP;
  END IF;

  UPDATE public.orders SET order_status = p_new_status WHERE id = p_order_id;

  SELECT user_id INTO v_cust_user_id FROM public.customers WHERE id = v_order.customer_id;
  IF v_cust_user_id IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_role, recipient_user_id, title, message, entity_type, entity_id)
    VALUES (
      'customer',
      v_cust_user_id,
      'Order Status Updated: ' || p_new_status,
      'Your order ' || v_order.order_number || ' is now ' || p_new_status || COALESCE(' — ' || p_notes, ''),
      'order',
      p_order_id
    );
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_actor, 'update_order_status', 'orders', p_order_id::text,
    jsonb_build_object('order_status', v_order.order_status),
    jsonb_build_object('order_status', p_new_status, 'notes', p_notes)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.split_order_to_purchase_orders(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  SELECT po_prefix INTO v_po_prefix FROM public.agency_settings WHERE id = 1;

  FOR v_mfg IN
    SELECT DISTINCT oif.manufacturer_id, oif.manufacturer_name_snapshot
    FROM public.order_items oi
    JOIN public.order_item_financials oif ON oif.order_item_id = oi.id
    LEFT JOIN public.purchase_order_items poi ON poi.order_item_id = oi.id
    WHERE oi.order_id = p_order_id AND poi.id IS NULL
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
      LEFT JOIN public.purchase_order_items poi ON poi.order_item_id = oi.id
      WHERE oi.order_id = p_order_id
        AND oif.manufacturer_id = v_mfg.manufacturer_id
        AND poi.id IS NULL
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

CREATE OR REPLACE FUNCTION public.create_manual_purchase_order(
  p_manufacturer_id uuid,
  p_items jsonb,
  p_expected_delivery_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_po_prefix text;
  v_po_number text;
  v_po_id uuid;
  v_entry jsonb;
  v_prod record;
  v_qty numeric(12,2);
  v_unit_price numeric(12,2);
  v_line_sub numeric(14,2);
  v_line_tax numeric(12,2);
  v_line_tot numeric(14,2);
  v_sub numeric(14,2) := 0;
  v_tax numeric(14,2) := 0;
  v_tot numeric(14,2) := 0;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one purchase order line item is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.manufacturers WHERE id = p_manufacturer_id) THEN
    RAISE EXCEPTION 'Manufacturer not found';
  END IF;

  SELECT po_prefix INTO v_po_prefix FROM public.agency_settings WHERE id = 1;
  v_po_number := COALESCE(v_po_prefix, 'PO') || '-' || to_char(now(), 'YYYYMMDD') || '-' || nextval('public.po_number_seq');

  INSERT INTO public.purchase_orders (
    po_number, manufacturer_id, status, expected_delivery_date, notes, created_by
  )
  VALUES (
    v_po_number, p_manufacturer_id, 'Draft', p_expected_delivery_date, p_notes, v_actor
  )
  RETURNING id INTO v_po_id;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT
      p.id, p.name, p.sku, p.unit_of_measurement, p.gst_rate, p.manufacturer_id,
      COALESCE(pp.draft_manufacturer_price, pp.published_manufacturer_price, 0) AS default_mfg_price
    INTO v_prod
    FROM public.products p
    LEFT JOIN public.product_prices pp ON pp.product_id = p.id
    WHERE p.id = (v_entry->>'product_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced product not found';
    END IF;

    IF v_prod.manufacturer_id <> p_manufacturer_id THEN
      RAISE EXCEPTION 'Product "%" does not belong to selected manufacturer', v_prod.name;
    END IF;

    v_qty := COALESCE((v_entry->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity for "%" must be greater than zero', v_prod.name;
    END IF;

    v_unit_price := COALESCE((v_entry->>'unit_manufacturer_price')::numeric, v_prod.default_mfg_price, 0);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Manufacturer price cannot be negative';
    END IF;

    v_line_sub := ROUND(v_unit_price * v_qty, 2);
    v_line_tax := ROUND(v_line_sub * v_prod.gst_rate / 100.0, 2);
    v_line_tot := ROUND(v_line_sub + v_line_tax, 2);

    v_sub := v_sub + v_line_sub;
    v_tax := v_tax + v_line_tax;
    v_tot := v_tot + v_line_tot;

    INSERT INTO public.purchase_order_items (
      purchase_order_id, product_id, product_name_snapshot, sku_snapshot,
      unit_snapshot, quantity, unit_manufacturer_price, gst_rate, tax_amount, line_total
    )
    VALUES (
      v_po_id, v_prod.id, v_prod.name, v_prod.sku, v_prod.unit_of_measurement,
      v_qty, v_unit_price, v_prod.gst_rate, v_line_tax, v_line_tot
    );
  END LOOP;

  UPDATE public.purchase_orders SET
    subtotal = v_sub,
    tax_total = v_tax,
    total_amount = v_tot
  WHERE id = v_po_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (v_actor, 'create_manual_po', 'purchase_orders', v_po_id::text, jsonb_build_object('po_number', v_po_number, 'total_amount', v_tot));

  RETURN jsonb_build_object('po_id', v_po_id, 'po_number', v_po_number, 'total_amount', v_tot);
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_purchase_order_stock(
  p_po_id uuid,
  p_add_to_inventory boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_po public.purchase_orders%ROWTYPE;
  v_item record;
  v_new_balance numeric(12,2);
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  IF v_po.status = 'Received' THEN
    RAISE EXCEPTION 'Purchase order is already marked Received';
  END IF;

  IF v_po.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cancelled purchase order cannot be received';
  END IF;

  UPDATE public.purchase_orders SET status = 'Received' WHERE id = p_po_id;

  IF p_add_to_inventory THEN
    FOR v_item IN SELECT * FROM public.purchase_order_items WHERE purchase_order_id = p_po_id LOOP
      UPDATE public.inventory
      SET available_quantity = available_quantity + v_item.quantity
      WHERE product_id = v_item.product_id
      RETURNING available_quantity INTO v_new_balance;

      INSERT INTO public.inventory_movements (
        product_id, movement_type, quantity_delta, balance_after,
        reference_type, reference_id, notes, created_by
      )
      VALUES (
        v_item.product_id, 'restock', v_item.quantity, COALESCE(v_new_balance, v_item.quantity),
        'purchase_order', p_po_id, 'Stock received via PO ' || v_po.po_number, v_actor
      );
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (v_actor, 'receive_po', 'purchase_orders', p_po_id::text, jsonb_build_object('po_number', v_po.po_number, 'add_to_inventory', p_add_to_inventory));
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_inventory_admin(
  p_product_id uuid,
  p_quantity_delta numeric,
  p_movement_type text DEFAULT 'manual_adjustment',
  p_notes text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_new_balance numeric(12,2);
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.inventory
  SET available_quantity = available_quantity + p_quantity_delta
  WHERE product_id = p_product_id
    AND (available_quantity + p_quantity_delta) >= 0
  RETURNING available_quantity INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid stock adjustment: resulting quantity cannot be negative';
  END IF;

  INSERT INTO public.inventory_movements (
    product_id, movement_type, quantity_delta, balance_after, reference_type, notes, created_by
  )
  VALUES (
    p_product_id, p_movement_type, p_quantity_delta, v_new_balance, 'manual', p_notes, v_actor
  );

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_actor, 'adjust_inventory', 'inventory', p_product_id::text,
    jsonb_build_object('delta', p_quantity_delta, 'balance_after', v_new_balance, 'notes', p_notes)
  );

  RETURN v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_customer_invoice(
  p_order_id uuid,
  p_due_days integer DEFAULT 15
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
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

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
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
    v_order.tax_total, v_order.total_amount, 0, 'unpaid', v_actor
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

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text DEFAULT NULL,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_inv public.invoices%ROWTYPE;
  v_new_paid numeric(14,2);
  v_new_status text;
  v_pay_id uuid;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF p_amount <= 0 OR (v_inv.paid_amount + p_amount) > (v_inv.total_amount + 0.01) THEN
    RAISE EXCEPTION 'Payment amount exceeds remaining invoice balance';
  END IF;

  INSERT INTO public.payments (
    invoice_id, customer_id, amount, payment_method, reference_number, payment_date, notes, recorded_by
  )
  VALUES (
    p_invoice_id, v_inv.customer_id, p_amount, p_payment_method, p_reference_number, p_payment_date, p_notes, v_actor
  )
  RETURNING id INTO v_pay_id;

  v_new_paid := LEAST(v_inv.total_amount, v_inv.paid_amount + p_amount);
  IF v_new_paid >= v_inv.total_amount THEN
    v_new_status := 'paid';
  ELSIF v_new_paid > 0 THEN
    v_new_status := 'partially_paid';
  ELSE
    v_new_status := 'unpaid';
  END IF;

  UPDATE public.invoices SET
    paid_amount = v_new_paid,
    payment_status = v_new_status
  WHERE id = p_invoice_id;

  UPDATE public.orders SET payment_status = v_new_status WHERE id = v_inv.order_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_actor, 'record_payment', 'payments', v_pay_id::text,
    jsonb_build_object('invoice_id', p_invoice_id, 'amount', p_amount, 'payment_status', v_new_status)
  );

  RETURN v_pay_id;
END;
$$;

-- ============================================================================
-- 6. ROW LEVEL SECURITY POLICIES (ALL TABLES)
-- ============================================================================

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manufacturers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manufacturer_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.margin_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Guard trigger preventing customers from altering status/email/user_id on self-update
CREATE OR REPLACE FUNCTION private.guard_customer_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Only agency staff can change customer account status, email, or user binding';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_customer_self_update ON public.customers;
CREATE TRIGGER trg_guard_customer_self_update
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION private.guard_customer_self_update();

-- Roles & Users
CREATE POLICY "Authenticated users can read roles" ON public.roles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users read own profile or admin/staff read all" ON public.users
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR private.is_admin_or_staff());

CREATE POLICY "Admin inserts users" ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin());

CREATE POLICY "Admin updates users" ON public.users
  FOR UPDATE TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

CREATE POLICY "Admin deletes users" ON public.users
  FOR DELETE TO authenticated
  USING (private.is_admin());

-- Agency settings (all authenticated can read agency details for invoices/branding; admin updates)
CREATE POLICY "Authenticated read agency settings" ON public.agency_settings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin updates agency settings" ON public.agency_settings
  FOR UPDATE TO authenticated
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- Categories (customers see active categories, admin/staff manage all)
CREATE POLICY "Read active categories or admin all" ON public.categories
  FOR SELECT TO authenticated
  USING (status = 'active' OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert categories" ON public.categories
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update categories" ON public.categories
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete categories" ON public.categories
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

-- Admin/Staff ONLY tables (Zero customer access)
CREATE POLICY "Admin staff only manufacturers" ON public.manufacturers
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only manufacturer_categories" ON public.manufacturer_categories
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only products" ON public.products
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only product_images" ON public.product_images
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only margin_rules" ON public.margin_rules
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only product_prices" ON public.product_prices
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only price_history" ON public.price_history
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only inventory" ON public.inventory
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only inventory_movements" ON public.inventory_movements
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only order_item_financials" ON public.order_item_financials
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only purchase_orders" ON public.purchase_orders
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff only purchase_order_items" ON public.purchase_order_items
  FOR ALL TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff read/insert audit_logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (private.is_admin_or_staff());

CREATE POLICY "Admin staff insert audit_logs" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff() AND actor_user_id = (SELECT auth.uid()));

-- Published Catalog (Customer-safe projection)
CREATE POLICY "Active customers read published catalog and admin reads all" ON public.published_catalog
  FOR SELECT TO authenticated
  USING ((is_published = true AND private.is_active_customer()) OR private.is_admin_or_staff());

-- Customers & Addresses
CREATE POLICY "Customers read own profile or admin staff all" ON public.customers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert customers" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Customers update own contact or admin staff all" ON public.customers
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR private.is_admin_or_staff())
  WITH CHECK (user_id = (SELECT auth.uid()) OR private.is_admin_or_staff());

CREATE POLICY "Admin staff delete customers" ON public.customers
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

CREATE POLICY "Customers manage own addresses or admin all" ON public.customer_addresses
  FOR ALL TO authenticated
  USING (customer_id = private.current_customer_id() OR private.is_admin_or_staff())
  WITH CHECK (customer_id = private.current_customer_id() OR private.is_admin_or_staff());

CREATE POLICY "Customers read own custom prices or admin manage all" ON public.customer_product_prices
  FOR SELECT TO authenticated
  USING ((customer_id = private.current_customer_id() AND is_active = true) OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert customer_product_prices" ON public.customer_product_prices
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update customer_product_prices" ON public.customer_product_prices
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete customer_product_prices" ON public.customer_product_prices
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

-- Cart Items (Customer manages own cart)
CREATE POLICY "Customers manage own cart" ON public.cart_items
  FOR ALL TO authenticated
  USING (customer_id = private.current_customer_id() AND private.is_active_customer())
  WITH CHECK (customer_id = private.current_customer_id() AND private.is_active_customer());

-- Orders & Order Items (Customers read own only; Admin/Staff read & manage all)
CREATE POLICY "Customers read own orders or admin staff all" ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id = private.current_customer_id() OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert orders" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete orders" ON public.orders
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

CREATE POLICY "Customers read own order items or admin staff all" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND o.customer_id = private.current_customer_id()
    )
    OR private.is_admin_or_staff()
  );

CREATE POLICY "Admin staff insert order items" ON public.order_items
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update order items" ON public.order_items
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete order items" ON public.order_items
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

-- Invoices & Payments
CREATE POLICY "Customers read own invoices or admin staff all" ON public.invoices
  FOR SELECT TO authenticated
  USING (customer_id = private.current_customer_id() OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert invoices" ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update invoices" ON public.invoices
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete invoices" ON public.invoices
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

CREATE POLICY "Customers read own payments or admin staff all" ON public.payments
  FOR SELECT TO authenticated
  USING (customer_id = private.current_customer_id() OR private.is_admin_or_staff());

CREATE POLICY "Admin staff insert payments" ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff update payments" ON public.payments
  FOR UPDATE TO authenticated
  USING (private.is_admin_or_staff())
  WITH CHECK (private.is_admin_or_staff());

CREATE POLICY "Admin staff delete payments" ON public.payments
  FOR DELETE TO authenticated
  USING (private.is_admin_or_staff());

-- Notifications
CREATE POLICY "Read own or role notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (
    recipient_user_id = (SELECT auth.uid())
    OR (recipient_role IN ('admin', 'staff') AND private.is_admin_or_staff())
  );

CREATE POLICY "Mark own or role notifications read" ON public.notifications
  FOR UPDATE TO authenticated
  USING (
    recipient_user_id = (SELECT auth.uid())
    OR (recipient_role IN ('admin', 'staff') AND private.is_admin_or_staff())
  )
  WITH CHECK (
    recipient_user_id = (SELECT auth.uid())
    OR (recipient_role IN ('admin', 'staff') AND private.is_admin_or_staff())
  );

-- ============================================================================
-- 7. STORAGE BUCKETS & POLICIES
-- ============================================================================

INSERT INTO storage.buckets (id, name, public) VALUES
  ('brand-assets', 'brand-assets', true),
  ('product-images', 'product-images', true),
  ('manufacturer-assets', 'manufacturer-assets', false)
ON CONFLICT (id) DO NOTHING;

-- Brand & Product images: public read, admin/staff full upsert (INSERT + SELECT + UPDATE + DELETE)
CREATE POLICY "Public read brand and product images" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id IN ('brand-assets', 'product-images'));

CREATE POLICY "Anon read brand and product images" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id IN ('brand-assets', 'product-images'));

CREATE POLICY "Admin staff write brand and product images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('brand-assets', 'product-images') AND private.is_admin_or_staff());

CREATE POLICY "Admin staff update brand and product images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id IN ('brand-assets', 'product-images') AND private.is_admin_or_staff())
  WITH CHECK (bucket_id IN ('brand-assets', 'product-images') AND private.is_admin_or_staff());

CREATE POLICY "Admin staff delete brand and product images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id IN ('brand-assets', 'product-images') AND private.is_admin_or_staff());

-- Manufacturer assets: strictly private to Admin/Staff
CREATE POLICY "Admin staff select manufacturer assets" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'manufacturer-assets' AND private.is_admin_or_staff());

CREATE POLICY "Admin staff insert manufacturer assets" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'manufacturer-assets' AND private.is_admin_or_staff());

CREATE POLICY "Admin staff update manufacturer assets" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'manufacturer-assets' AND private.is_admin_or_staff())
  WITH CHECK (bucket_id = 'manufacturer-assets' AND private.is_admin_or_staff());

CREATE POLICY "Admin staff delete manufacturer assets" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'manufacturer-assets' AND private.is_admin_or_staff());
