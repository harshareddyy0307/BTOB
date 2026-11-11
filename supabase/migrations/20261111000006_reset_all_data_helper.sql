-- ============================================================================
-- Migration 011: Atomic Platform Data Reset RPC (Service Role Only)
-- ============================================================================
-- Clears all operational business data (customers, manufacturers, categories,
-- products, catalog projections, margins & price history, inventory & stock
-- movements, orders, purchase orders, invoices, payments, notifications,
-- audit logs, rate-limit entries, and document number sequences), while
-- strictly preserving the calling Agency Owner Admin account, roles table,
-- and (unless requested) Agency Profile & Staff accounts.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_all_platform_data(
  p_caller_id uuid,
  p_reset_agency_settings boolean DEFAULT false,
  p_delete_staff boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth_user_ids_to_delete uuid[];
  v_counts jsonb;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: Privileged server execution required';
  END IF;

  IF p_caller_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.roles r ON r.id = u.role_id
    WHERE u.id = p_caller_id
      AND u.is_active = true
      AND r.name = 'admin'
  ) THEN
    RAISE EXCEPTION 'Forbidden: Active Agency Owner Admin account required';
  END IF;

  -- Collect auth/user IDs to remove before deleting customer & user records.
  -- Always exclude p_caller_id so the Agency Owner Admin cannot delete themselves.
  SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::uuid[])
  INTO v_auth_user_ids_to_delete
  FROM (
    SELECT u.id AS uid
    FROM public.users u
    JOIN public.roles r ON r.id = u.role_id
    WHERE u.id <> p_caller_id
      AND (
        r.name = 'customer'
        OR (p_delete_staff AND r.name IN ('staff', 'admin'))
      )
    UNION
    SELECT c.user_id AS uid
    FROM public.customers c
    WHERE c.user_id IS NOT NULL
      AND c.user_id <> p_caller_id
  ) target_users;

  -- Snapshot pre-reset record counts for reporting/audit summary
  v_counts := jsonb_build_object(
    'payments', (SELECT count(*) FROM public.payments),
    'invoices', (SELECT count(*) FROM public.invoices),
    'purchase_orders', (SELECT count(*) FROM public.purchase_orders),
    'orders', (SELECT count(*) FROM public.orders),
    'customers', (SELECT count(*) FROM public.customers),
    'products', (SELECT count(*) FROM public.products),
    'manufacturers', (SELECT count(*) FROM public.manufacturers),
    'categories', (SELECT count(*) FROM public.categories),
    'margin_overrides', (SELECT count(*) FROM public.margin_rules WHERE scope <> 'global'),
    'notifications', (SELECT count(*) FROM public.notifications),
    'audit_logs', (SELECT count(*) FROM public.audit_logs),
    'user_accounts', COALESCE(cardinality(v_auth_user_ids_to_delete), 0)
  );

  -- 1. Orders, Purchase Orders, Invoices, Payments & Carts (respect RESTRICT FKs)
  -- Explicit WHERE clauses satisfy Supabase pg_safeupdate on PostgREST RPC sessions.
  DELETE FROM public.payments WHERE id IS NOT NULL;
  DELETE FROM public.invoices WHERE id IS NOT NULL;
  DELETE FROM public.purchase_order_items WHERE id IS NOT NULL;
  DELETE FROM public.purchase_orders WHERE id IS NOT NULL;
  DELETE FROM public.order_item_financials WHERE order_item_id IS NOT NULL;
  DELETE FROM public.order_items WHERE id IS NOT NULL;
  DELETE FROM public.orders WHERE id IS NOT NULL;
  DELETE FROM public.cart_items WHERE id IS NOT NULL;

  -- 2. Customers & Custom Pricing
  DELETE FROM public.customer_product_prices WHERE id IS NOT NULL;
  DELETE FROM public.customer_addresses WHERE id IS NOT NULL;
  DELETE FROM public.customers WHERE id IS NOT NULL;

  -- 3. Products before child tables so catalog-sync triggers see products deleted
  DELETE FROM public.products WHERE id IS NOT NULL;
  DELETE FROM public.published_catalog WHERE product_id IS NOT NULL;
  DELETE FROM public.price_history WHERE id IS NOT NULL;
  DELETE FROM public.product_prices WHERE product_id IS NOT NULL;
  DELETE FROM public.product_images WHERE id IS NOT NULL;
  DELETE FROM public.inventory_movements WHERE id IS NOT NULL;
  DELETE FROM public.inventory WHERE product_id IS NOT NULL;

  -- 4. Manufacturers, Margin Rules & Categories
  DELETE FROM public.manufacturer_categories WHERE manufacturer_id IS NOT NULL;
  DELETE FROM public.manufacturers WHERE id IS NOT NULL;

  DELETE FROM public.margin_rules WHERE id IS NOT NULL;
  INSERT INTO public.margin_rules (scope, margin_percentage, is_active, notes, updated_by)
  VALUES ('global', 15.00, true, 'Default agency global margin', p_caller_id);

  -- Detach nested parent links before deleting all categories cleanly
  UPDATE public.categories SET parent_id = NULL WHERE parent_id IS NOT NULL;
  DELETE FROM public.categories WHERE id IS NOT NULL;

  -- 5. Notifications, Old Audit Logs & Transient Auth Rate Limits
  DELETE FROM public.notifications WHERE id IS NOT NULL;
  DELETE FROM public.audit_logs WHERE id IS NOT NULL;
  DELETE FROM private.auth_rate_limits WHERE bucket IS NOT NULL;

  -- 6. Customer (and optionally Staff / other Admin) profile rows in public.users
  IF COALESCE(cardinality(v_auth_user_ids_to_delete), 0) > 0 THEN
    DELETE FROM public.users
    WHERE id = ANY(v_auth_user_ids_to_delete)
      AND id <> p_caller_id;
  END IF;

  -- 7. Reset document number sequences back to 1001
  PERFORM setval('public.order_number_seq', 1001, false);
  PERFORM setval('public.po_number_seq', 1001, false);
  PERFORM setval('public.invoice_number_seq', 1001, false);

  -- 8. Optional factory reset of Agency Profile & GST configuration
  IF p_reset_agency_settings THEN
    UPDATE public.agency_settings
    SET
      agency_name = 'TradeBridge B2B Supply Agency',
      legal_name = 'TradeBridge Distribution Pvt. Ltd.',
      gstin = '',
      pan = '',
      address = '',
      city = '',
      state = 'Telangana',
      pincode = '',
      phone = '',
      email = '',
      logo_url = NULL,
      default_gst_rate = 18.00,
      currency_symbol = '₹',
      order_prefix = 'ORD',
      po_prefix = 'PO',
      invoice_prefix = 'INV',
      bank_details = '',
      terms_and_conditions = 'Goods once sold will not be taken back. Payment due within agreed credit terms.'
    WHERE id = 1;
  END IF;

  -- Record a clean fresh audit stamp documenting the reset event
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_caller_id,
    'reset_all_platform_data',
    'system',
    'all',
    jsonb_build_object(
      'reset_agency_settings', p_reset_agency_settings,
      'deleted_staff_accounts', p_delete_staff,
      'deleted_counts', v_counts
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'deleted_counts', v_counts,
    'deleted_auth_user_ids', to_jsonb(COALESCE(v_auth_user_ids_to_delete, ARRAY[]::uuid[]))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_all_platform_data(uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_all_platform_data(uuid, boolean, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
