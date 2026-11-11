-- ============================================================================
-- Migration 009: Gross Margin on Selling Price Formula, Recursive Category
-- Ancestor Inheritance, Safe Rule Removal, Override Clearing & Custom Price
-- Order Financial Snapshots
-- ============================================================================

-- 1. Enforce valid Gross Margin % range [0, 100) so Cost / (1 - Margin%) is well-defined
ALTER TABLE public.margin_rules
  DROP CONSTRAINT IF EXISTS margin_rules_margin_percentage_check;

ALTER TABLE public.margin_rules
  ADD CONSTRAINT margin_rules_margin_percentage_check
  CHECK (margin_percentage >= 0 AND margin_percentage < 100);

-- 2. Resolve effective margin with Product > Category Ancestor Chain > Global
CREATE OR REPLACE FUNCTION public.resolve_effective_margin(p_product_id uuid)
RETURNS TABLE (margin_source text, margin_percentage numeric)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_pct numeric;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- 1. Product-level margin override
  SELECT mr.margin_percentage INTO v_pct
  FROM public.margin_rules mr
  WHERE mr.scope = 'product' AND mr.product_id = p_product_id AND mr.is_active = true
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT 'product'::text, v_pct;
    RETURN;
  END IF;

  -- 2. Category-level margin (nearest ancestor along category hierarchy)
  SELECT mr.margin_percentage INTO v_pct
  FROM (
    WITH RECURSIVE cat_ancestors AS (
      SELECT c.id, c.parent_id, 0 AS depth, ARRAY[c.id] AS path
      FROM public.products p
      JOIN public.categories c ON c.id = p.category_id
      WHERE p.id = p_product_id
      UNION ALL
      SELECT parent.id, parent.parent_id, ca.depth + 1, ca.path || parent.id
      FROM cat_ancestors ca
      JOIN public.categories parent ON parent.id = ca.parent_id
      WHERE ca.parent_id IS NOT NULL
        AND NOT (parent.id = ANY(ca.path))
    )
    SELECT mr2.margin_percentage
    FROM cat_ancestors ca
    JOIN public.margin_rules mr2
      ON mr2.scope = 'category'
     AND mr2.category_id = ca.id
     AND mr2.is_active = true
    ORDER BY ca.depth ASC
    LIMIT 1
  ) mr;

  IF FOUND THEN
    RETURN QUERY SELECT 'category'::text, v_pct;
    RETURN;
  END IF;

  -- 3. Global default margin
  SELECT mr.margin_percentage INTO v_pct
  FROM public.margin_rules mr
  WHERE mr.scope = 'global' AND mr.is_active = true
  LIMIT 1;

  RETURN QUERY SELECT 'global'::text, COALESCE(v_pct, 15.00);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_effective_margin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_effective_margin(uuid) TO authenticated;

-- 3. Recalculate draft price using Gross Margin on Selling Price:
--    Selling Price = Cost / (1 - Margin% / 100), Margin Amount = Selling Price - Cost
CREATE OR REPLACE FUNCTION public.recalculate_product_draft_price(
  p_product_id uuid,
  p_new_manufacturer_price numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
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
  v_changed boolean;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_existing FROM public.product_prices WHERE product_id = p_product_id;
  v_mfg_price := ROUND(GREATEST(COALESCE(p_new_manufacturer_price, v_existing.draft_manufacturer_price, 0), 0), 2);

  SELECT * INTO v_eff FROM public.resolve_effective_margin(p_product_id);
  IF v_eff.margin_percentage < 0 OR v_eff.margin_percentage >= 100 THEN
    RAISE EXCEPTION 'Margin percentage (%) must be >= 0%% and < 100%% for selling-price margin calculation', v_eff.margin_percentage;
  END IF;

  v_selling := ROUND(v_mfg_price / (1.0 - (v_eff.margin_percentage / 100.0)), 2);
  v_margin_amt := ROUND(v_selling - v_mfg_price, 2);

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
    IF v_existing.published_at IS NOT NULL
       AND v_existing.published_selling_price = v_selling
       AND v_existing.published_manufacturer_price = v_mfg_price
       AND v_existing.published_margin_source = v_eff.margin_source
       AND v_existing.published_margin_percentage = v_eff.margin_percentage THEN
      v_status := 'published';
    ELSE
      v_status := 'pending_review';
    END IF;

    v_changed := (
      v_existing.draft_manufacturer_price IS DISTINCT FROM v_mfg_price
      OR v_existing.draft_margin_source IS DISTINCT FROM v_eff.margin_source
      OR v_existing.draft_margin_percentage IS DISTINCT FROM v_eff.margin_percentage
      OR v_existing.draft_margin_amount IS DISTINCT FROM v_margin_amt
      OR v_existing.draft_selling_price IS DISTINCT FROM v_selling
      OR v_existing.approval_status IS DISTINCT FROM v_status
    );

    IF v_changed THEN
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
  END IF;

  IF v_existing.product_id IS NULL
     OR v_existing.draft_manufacturer_price IS DISTINCT FROM v_mfg_price
     OR v_existing.draft_margin_source IS DISTINCT FROM v_eff.margin_source
     OR v_existing.draft_margin_percentage IS DISTINCT FROM v_eff.margin_percentage
     OR v_existing.draft_selling_price IS DISTINCT FROM v_selling THEN
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
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_product_draft_price(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_product_draft_price(uuid, numeric, text) TO authenticated;

-- 4. Publish draft prices (with optional keep-draft-status mode when updating published prices only)
CREATE OR REPLACE FUNCTION public.publish_product_prices(
  p_product_ids uuid[],
  p_mark_products_published boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_pid uuid;
  v_price public.product_prices%ROWTYPE;
  v_prod public.products%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  FOREACH v_pid IN ARRAY p_product_ids LOOP
    SELECT * INTO v_price FROM public.product_prices WHERE product_id = v_pid;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF COALESCE(v_price.draft_selling_price, 0) <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_prod FROM public.products WHERE id = v_pid;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF NOT p_mark_products_published AND v_prod.is_published = false THEN
      CONTINUE;
    END IF;

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

    IF p_mark_products_published AND v_prod.is_published = false THEN
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
      CASE
        WHEN p_mark_products_published THEN 'Published to customer catalog'
        ELSE 'Published price update to customer catalog'
      END,
      v_actor
    );

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_actor,
    CASE WHEN p_mark_products_published THEN 'publish_prices' ELSE 'update_published_prices' END,
    'product_prices',
    array_to_string(p_product_ids, ','),
    jsonb_build_object('count', v_count, 'mark_published', p_mark_products_published)
  );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_product_prices(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_product_prices(uuid[], boolean) TO authenticated;

-- 5. Upsert margin rule with recursive subcategories & optional child override clearing
CREATE OR REPLACE FUNCTION public.upsert_margin_rule_and_recalculate(
  p_scope text,
  p_margin_percentage numeric,
  p_category_id uuid,
  p_product_id uuid,
  p_notes text,
  p_clear_child_overrides boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
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

  IF p_margin_percentage IS NULL OR p_margin_percentage < 0 OR p_margin_percentage >= 100 THEN
    RAISE EXCEPTION 'Margin percentage (%) must be between 0%% and 99.99%%', p_margin_percentage;
  END IF;

  IF p_scope = 'global' THEN
    UPDATE public.margin_rules SET is_active = false WHERE scope = 'global' AND is_active = true;
    IF p_clear_child_overrides THEN
      UPDATE public.margin_rules SET is_active = false WHERE scope IN ('category', 'product') AND is_active = true;
    END IF;
  ELSIF p_scope = 'category' THEN
    IF p_category_id IS NULL THEN
      RAISE EXCEPTION 'Category ID is required for category margin rule';
    END IF;
    UPDATE public.margin_rules SET is_active = false WHERE scope = 'category' AND category_id = p_category_id AND is_active = true;
    IF p_clear_child_overrides THEN
      WITH RECURSIVE cat_tree AS (
        SELECT c.id, ARRAY[c.id] AS path
        FROM public.categories c
        WHERE c.id = p_category_id
        UNION ALL
        SELECT child.id, ct.path || child.id
        FROM cat_tree ct
        JOIN public.categories child ON child.parent_id = ct.id
        WHERE NOT (child.id = ANY(ct.path))
      )
      UPDATE public.margin_rules mr
      SET is_active = false
      WHERE mr.is_active = true
        AND (
          (mr.scope = 'category' AND mr.category_id IN (SELECT id FROM cat_tree))
          OR (
            mr.scope = 'product'
            AND mr.product_id IN (SELECT p.id FROM public.products p WHERE p.category_id IN (SELECT id FROM cat_tree))
          )
        );
    END IF;
  ELSIF p_scope = 'product' THEN
    IF p_product_id IS NULL THEN
      RAISE EXCEPTION 'Product ID is required for product margin rule';
    END IF;
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
      WITH RECURSIVE cat_tree AS (
        SELECT c.id, ARRAY[c.id] AS path
        FROM public.categories c
        WHERE c.id = p_category_id
        UNION ALL
        SELECT child.id, ct.path || child.id
        FROM cat_tree ct
        JOIN public.categories child ON child.parent_id = ct.id
        WHERE NOT (child.id = ANY(ct.path))
      )
      SELECT p.id
      FROM public.products p
      WHERE p.category_id IN (SELECT id FROM cat_tree)
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
    v_actor,
    'upsert_margin_rule',
    'margin_rules',
    v_rule_id::text,
    jsonb_build_object(
      'scope', p_scope,
      'category_id', p_category_id,
      'product_id', p_product_id,
      'margin_percentage', p_margin_percentage,
      'clear_child_overrides', p_clear_child_overrides
    )
  );

  RETURN v_rule_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_margin_rule_and_recalculate(
  p_scope text,
  p_margin_percentage numeric,
  p_category_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN public.upsert_margin_rule_and_recalculate(
    p_scope,
    p_margin_percentage,
    p_category_id,
    p_product_id,
    p_notes,
    false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text) TO authenticated;

-- 6. Atomic margin override removal & recursive recalculation RPC
CREATE OR REPLACE FUNCTION public.remove_margin_rule_and_recalculate(
  p_rule_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_rule public.margin_rules%ROWTYPE;
  v_pid uuid;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_rule FROM public.margin_rules WHERE id = p_rule_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Margin rule not found or already removed';
  END IF;

  IF v_rule.scope = 'global' THEN
    RAISE EXCEPTION 'Default global margin rule cannot be removed';
  END IF;

  UPDATE public.margin_rules
  SET is_active = false, updated_by = v_actor
  WHERE id = p_rule_id;

  IF v_rule.scope = 'product' AND v_rule.product_id IS NOT NULL THEN
    PERFORM public.recalculate_product_draft_price(v_rule.product_id, NULL, 'Product margin override removed');
  ELSIF v_rule.scope = 'category' AND v_rule.category_id IS NOT NULL THEN
    FOR v_pid IN
      WITH RECURSIVE cat_tree AS (
        SELECT c.id, ARRAY[c.id] AS path
        FROM public.categories c
        WHERE c.id = v_rule.category_id
        UNION ALL
        SELECT child.id, ct.path || child.id
        FROM cat_tree ct
        JOIN public.categories child ON child.parent_id = ct.id
        WHERE NOT (child.id = ANY(ct.path))
      )
      SELECT p.id
      FROM public.products p
      WHERE p.category_id IN (SELECT id FROM cat_tree)
    LOOP
      PERFORM public.recalculate_product_draft_price(v_pid, NULL, 'Category margin override removed');
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data)
  VALUES (
    v_actor,
    'remove_margin_rule',
    'margin_rules',
    p_rule_id::text,
    jsonb_build_object(
      'scope', v_rule.scope,
      'category_id', v_rule.category_id,
      'product_id', v_rule.product_id,
      'margin_percentage', v_rule.margin_percentage
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.remove_margin_rule_and_recalculate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_margin_rule_and_recalculate(uuid) TO authenticated;

-- 7. Recalculate products under a category tree (used when category hierarchy changes)
CREATE OR REPLACE FUNCTION public.recalculate_category_products_draft_price(
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_pid uuid;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  FOR v_pid IN
    WITH RECURSIVE cat_tree AS (
      SELECT c.id, ARRAY[c.id] AS path
      FROM public.categories c
      WHERE c.id = p_category_id
      UNION ALL
      SELECT child.id, ct.path || child.id
      FROM cat_tree ct
      JOIN public.categories child ON child.parent_id = ct.id
      WHERE NOT (child.id = ANY(ct.path))
    )
    SELECT p.id
    FROM public.products p
    WHERE p.category_id IN (SELECT id FROM cat_tree)
  LOOP
    PERFORM public.recalculate_product_draft_price(v_pid, NULL, 'Category hierarchy updated');
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_category_products_draft_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_category_products_draft_price(uuid) TO authenticated;

-- 8. Fix place_customer_order margin_percentage_snapshot when custom_selling_price is used
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
  v_eff_margin_pct numeric(7,2);
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

    IF v_item.custom_selling_price IS NOT NULL THEN
      v_eff_margin_pct := GREATEST(
        -99999.99,
        LEAST(100.00, ROUND(((v_selling_price - v_item.published_manufacturer_price) / v_selling_price) * 100.0, 2))
      );
    ELSE
      v_eff_margin_pct := v_item.published_margin_percentage;
    END IF;

    INSERT INTO public.order_item_financials (
      order_item_id, manufacturer_id, manufacturer_name_snapshot,
      unit_manufacturer_price, margin_percentage_snapshot, margin_amount_total
    )
    VALUES (
      v_order_item_id, v_item.manufacturer_id, v_item.manufacturer_name,
      v_item.published_manufacturer_price, v_eff_margin_pct, v_margin_total
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

-- 9. Backfill existing product_prices drafts using the Gross Margin on Selling Price formula
--    (keeps published_* prices and is_published status intact for Admin review & publish)
DO $$
DECLARE
  v_rec record;
  v_eff_source text;
  v_eff_pct numeric;
  v_selling numeric(12,2);
  v_margin_amt numeric(12,2);
  v_status text;
BEGIN
  FOR v_rec IN
    SELECT
      p.id AS product_id,
      pp.draft_manufacturer_price,
      pp.draft_margin_source,
      pp.draft_margin_percentage,
      pp.draft_selling_price,
      pp.published_manufacturer_price,
      pp.published_margin_source,
      pp.published_margin_percentage,
      pp.published_selling_price,
      pp.published_at,
      pp.approval_status
    FROM public.products p
    JOIN public.product_prices pp ON pp.product_id = p.id
  LOOP
    -- Resolve effective margin without auth context
    SELECT mr.margin_percentage INTO v_eff_pct
    FROM public.margin_rules mr
    WHERE mr.scope = 'product' AND mr.product_id = v_rec.product_id AND mr.is_active = true
    LIMIT 1;

    IF FOUND THEN
      v_eff_source := 'product';
    ELSE
      SELECT mr2.margin_percentage INTO v_eff_pct
      FROM (
        WITH RECURSIVE cat_ancestors AS (
          SELECT c.id, c.parent_id, 0 AS depth, ARRAY[c.id] AS path
          FROM public.products p2
          JOIN public.categories c ON c.id = p2.category_id
          WHERE p2.id = v_rec.product_id
          UNION ALL
          SELECT parent.id, parent.parent_id, ca.depth + 1, ca.path || parent.id
          FROM cat_ancestors ca
          JOIN public.categories parent ON parent.id = ca.parent_id
          WHERE ca.parent_id IS NOT NULL
            AND NOT (parent.id = ANY(ca.path))
        )
        SELECT mr3.margin_percentage
        FROM cat_ancestors ca
        JOIN public.margin_rules mr3
          ON mr3.scope = 'category'
         AND mr3.category_id = ca.id
         AND mr3.is_active = true
        ORDER BY ca.depth ASC
        LIMIT 1
      ) mr2;

      IF FOUND THEN
        v_eff_source := 'category';
      ELSE
        SELECT mr.margin_percentage INTO v_eff_pct
        FROM public.margin_rules mr
        WHERE mr.scope = 'global' AND mr.is_active = true
        LIMIT 1;
        v_eff_source := 'global';
        v_eff_pct := COALESCE(v_eff_pct, 15.00);
      END IF;
    END IF;

    v_selling := ROUND(v_rec.draft_manufacturer_price / (1.0 - (v_eff_pct / 100.0)), 2);
    v_margin_amt := ROUND(v_selling - v_rec.draft_manufacturer_price, 2);

    IF v_rec.published_at IS NOT NULL
       AND v_rec.published_selling_price = v_selling
       AND v_rec.published_manufacturer_price = v_rec.draft_manufacturer_price
       AND v_rec.published_margin_source = v_eff_source
       AND v_rec.published_margin_percentage = v_eff_pct THEN
      v_status := 'published';
    ELSE
      v_status := 'pending_review';
    END IF;

    IF v_rec.draft_selling_price IS DISTINCT FROM v_selling
       OR v_rec.draft_margin_source IS DISTINCT FROM v_eff_source
       OR v_rec.draft_margin_percentage IS DISTINCT FROM v_eff_pct
       OR v_rec.approval_status IS DISTINCT FROM v_status THEN
      UPDATE public.product_prices SET
        draft_margin_source = v_eff_source,
        draft_margin_percentage = v_eff_pct,
        draft_margin_amount = v_margin_amt,
        draft_selling_price = v_selling,
        approval_status = v_status
      WHERE product_id = v_rec.product_id;

      INSERT INTO public.price_history (
        product_id, old_manufacturer_price, new_manufacturer_price,
        old_margin_percentage, new_margin_percentage,
        old_selling_price, new_selling_price, action, notes
      )
      VALUES (
        v_rec.product_id,
        v_rec.draft_manufacturer_price,
        v_rec.draft_manufacturer_price,
        v_rec.draft_margin_percentage,
        v_eff_pct,
        v_rec.draft_selling_price,
        v_selling,
        'draft_calculated',
        'Recalculated using Gross Margin on Selling Price formula'
      );
    END IF;
  END LOOP;
END $$;
