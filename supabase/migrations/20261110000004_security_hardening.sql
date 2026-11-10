-- ============================================================================
-- Migration 004: RPC Privilege Hardening & SECURITY INVOKER for Admin RPCs
-- ============================================================================

CREATE POLICY "Admin staff insert notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (private.is_admin_or_staff());

GRANT USAGE, SELECT ON SEQUENCE public.po_number_seq, public.invoice_number_seq TO authenticated;

-- Revoke PUBLIC & anon EXECUTE on all authenticated/privileged RPCs
REVOKE ALL ON FUNCTION public.add_to_cart(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_to_cart(uuid, numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.place_customer_order(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_customer_order(jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION public.resolve_effective_margin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_effective_margin(uuid) TO authenticated;
ALTER FUNCTION public.resolve_effective_margin(uuid) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.recalculate_product_draft_price(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_product_draft_price(uuid, numeric, text) TO authenticated;
ALTER FUNCTION public.recalculate_product_draft_price(uuid, numeric, text) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.publish_product_prices(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_product_prices(uuid[], boolean) TO authenticated;
ALTER FUNCTION public.publish_product_prices(uuid[], boolean) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text) TO authenticated;
ALTER FUNCTION public.upsert_margin_rule_and_recalculate(text, numeric, uuid, uuid, text) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.update_order_status_admin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_status_admin(uuid, text, text) TO authenticated;
ALTER FUNCTION public.update_order_status_admin(uuid, text, text) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.split_order_to_purchase_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_order_to_purchase_orders(uuid) TO authenticated;
ALTER FUNCTION public.split_order_to_purchase_orders(uuid) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.create_manual_purchase_order(uuid, jsonb, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_purchase_order(uuid, jsonb, date, text) TO authenticated;
ALTER FUNCTION public.create_manual_purchase_order(uuid, jsonb, date, text) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.receive_purchase_order_stock(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order_stock(uuid, boolean) TO authenticated;
ALTER FUNCTION public.receive_purchase_order_stock(uuid, boolean) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.adjust_inventory_admin(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory_admin(uuid, numeric, text, text) TO authenticated;
ALTER FUNCTION public.adjust_inventory_admin(uuid, numeric, text, text) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.generate_customer_invoice(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_invoice(uuid, integer) TO authenticated;
ALTER FUNCTION public.generate_customer_invoice(uuid, integer) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, numeric, text, text, date, text) TO authenticated;
ALTER FUNCTION public.record_invoice_payment(uuid, numeric, text, text, date, text) SECURITY INVOKER;
