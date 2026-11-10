-- ============================================================================
-- Migration 005: Order-Level Paid / Unpaid / Partial Payment & Due Tracking
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  ADD COLUMN IF NOT EXISTS due_amount numeric(14,2) GENERATED ALWAYS AS (GREATEST(0::numeric, total_amount - paid_amount)) STORED;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided'));

CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_status ON public.payments(invoice_id, status);

-- Backfill orders from existing invoices/payments
UPDATE public.orders o
SET
  paid_amount = LEAST(o.total_amount, GREATEST(0, COALESCE(i.paid_amount, 0))),
  payment_status = CASE
    WHEN LEAST(o.total_amount, GREATEST(0, COALESCE(i.paid_amount, 0))) >= o.total_amount AND o.total_amount > 0 THEN 'paid'
    WHEN LEAST(o.total_amount, GREATEST(0, COALESCE(i.paid_amount, 0))) > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END
FROM public.invoices i
WHERE i.order_id = o.id;

UPDATE public.orders
SET paid_amount = total_amount
WHERE payment_status = 'paid' AND paid_amount = 0 AND total_amount > 0;

-- Keep invoice generation synced with any pre-existing order payment state
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

-- Keep invoice payment recording fully synced with orders.paid_amount, orders.due_amount, and notifications
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
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_inv public.invoices%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_cust_user_id uuid;
  v_applied numeric(14,2);
  v_new_paid numeric(14,2);
  v_new_due numeric(14,2);
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

  SELECT * INTO v_order FROM public.orders WHERE id = v_inv.order_id FOR UPDATE;
  IF v_order.order_status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot record payment for a cancelled order';
  END IF;

  IF p_amount IS NULL OR ROUND(p_amount, 2) <= 0 OR ROUND(p_amount, 2) > (GREATEST(0::numeric, v_inv.total_amount - v_inv.paid_amount) + 0.01) THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero and within remaining invoice balance';
  END IF;

  v_applied := LEAST(GREATEST(0::numeric, v_inv.total_amount - v_inv.paid_amount), ROUND(p_amount, 2));
  IF v_applied <= 0 THEN
    RAISE EXCEPTION 'Invoice is already fully paid';
  END IF;

  INSERT INTO public.payments (
    invoice_id, customer_id, amount, payment_method, reference_number, payment_date, notes, recorded_by
  )
  VALUES (
    p_invoice_id, v_inv.customer_id, v_applied, p_payment_method,
    NULLIF(trim(COALESCE(p_reference_number, '')), ''), COALESCE(p_payment_date, CURRENT_DATE),
    NULLIF(trim(COALESCE(p_notes, '')), ''), v_actor
  )
  RETURNING id INTO v_pay_id;

  v_new_paid := LEAST(v_inv.total_amount, ROUND(v_inv.paid_amount + v_applied, 2));
  v_new_due := GREATEST(0::numeric, v_inv.total_amount - v_new_paid);

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

  UPDATE public.orders SET
    paid_amount = v_new_paid,
    payment_status = v_new_status
  WHERE id = v_inv.order_id;

  UPDATE public.notifications
  SET is_read = true
  WHERE entity_type = 'order_payment_claim' AND entity_id = v_inv.order_id AND is_read = false;

  SELECT user_id INTO v_cust_user_id FROM public.customers WHERE id = v_inv.customer_id;
  IF v_cust_user_id IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_role, recipient_user_id, title, message, entity_type, entity_id)
    VALUES (
      'customer',
      v_cust_user_id,
      'Payment Recorded: ' || v_order.order_number,
      'Payment of ₹' || v_applied::text || ' (' || p_payment_method || ') applied to order ' || v_order.order_number || '. Paid: ₹' || v_new_paid::text || ', Remaining Due: ₹' || v_new_due::text || '.',
      'order',
      v_inv.order_id
    );
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_actor, 'record_payment', 'payments', v_pay_id::text,
    jsonb_build_object('invoice_id', p_invoice_id, 'order_id', v_inv.order_id, 'amount', v_applied, 'paid_amount', v_new_paid, 'due_amount', v_new_due, 'payment_status', v_new_status)
  );

  RETURN v_pay_id;
END;
$$;

-- Direct Admin Order Payment RPC: Mark Paid / Partially Paid / Unpaid from Orders or Operations
CREATE OR REPLACE FUNCTION public.update_order_payment_admin(
  p_order_id uuid,
  p_action text,
  p_amount numeric DEFAULT NULL,
  p_payment_method text DEFAULT 'Bank Transfer',
  p_reference_number text DEFAULT NULL,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_order public.orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_inv_id uuid;
  v_due numeric(14,2);
  v_applied_amount numeric(14,2) := 0;
  v_new_paid numeric(14,2);
  v_new_due numeric(14,2);
  v_new_status text;
  v_pay_id uuid;
  v_prev_payments jsonb;
BEGIN
  IF NOT private.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_action NOT IN ('mark_paid', 'partial_payment', 'mark_unpaid') THEN
    RAISE EXCEPTION 'Invalid payment action: %', p_action;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.order_status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot update payment status on a cancelled order';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE id = v_order.customer_id;
  SELECT * INTO v_inv FROM public.invoices WHERE order_id = p_order_id FOR UPDATE;
  v_due := GREATEST(0::numeric, v_order.total_amount - v_order.paid_amount);

  IF p_action = 'mark_unpaid' THEN
    IF v_inv.id IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'method', payment_method, 'ref', reference_number, 'date', payment_date)), '[]'::jsonb)
      INTO v_prev_payments
      FROM public.payments
      WHERE invoice_id = v_inv.id AND status = 'recorded';

      UPDATE public.payments
      SET
        status = 'voided',
        notes = trim(both ' ' FROM COALESCE(notes || ' | ', '') || 'Reversed / marked unpaid' || COALESCE(': ' || NULLIF(trim(p_notes), ''), ''))
      WHERE invoice_id = v_inv.id AND status = 'recorded';

      UPDATE public.invoices SET paid_amount = 0, payment_status = 'unpaid' WHERE id = v_inv.id;
    ELSE
      v_prev_payments := '[]'::jsonb;
    END IF;

    UPDATE public.orders SET paid_amount = 0, payment_status = 'unpaid' WHERE id = p_order_id;

    UPDATE public.notifications
    SET is_read = true
    WHERE entity_type = 'order_payment_claim' AND entity_id = p_order_id AND is_read = false;

    IF v_customer.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_role, recipient_user_id, title, message, entity_type, entity_id)
      VALUES (
        'customer',
        v_customer.user_id,
        'Payment Status Updated: ' || v_order.order_number,
        'Order ' || v_order.order_number || ' payment status was set to Unpaid. Amount Due: ₹' || v_order.total_amount::text || COALESCE(' — ' || NULLIF(trim(p_notes), ''), ''),
        'order',
        p_order_id
      );
    END IF;

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data, new_data)
    VALUES (
      v_actor, 'mark_order_unpaid', 'orders', p_order_id::text,
      jsonb_build_object('paid_amount', v_order.paid_amount, 'payment_status', v_order.payment_status, 'voided_payments', v_prev_payments),
      jsonb_build_object('paid_amount', 0, 'due_amount', v_order.total_amount, 'payment_status', 'unpaid', 'notes', p_notes)
    );

    RETURN jsonb_build_object(
      'order_id', p_order_id,
      'invoice_id', v_inv.id,
      'paid_amount', 0,
      'due_amount', v_order.total_amount,
      'payment_status', 'unpaid'
    );
  END IF;

  -- mark_paid or partial_payment
  IF p_payment_method NOT IN ('Bank Transfer', 'UPI', 'NEFT/RTGS', 'Cheque', 'Cash', 'Card') THEN
    RAISE EXCEPTION 'Invalid payment method: %', p_payment_method;
  END IF;

  IF p_action = 'mark_paid' THEN
    IF v_due <= 0 THEN
      UPDATE public.orders SET payment_status = 'paid' WHERE id = p_order_id;
      IF v_inv.id IS NOT NULL THEN
        UPDATE public.invoices SET paid_amount = v_order.total_amount, payment_status = 'paid' WHERE id = v_inv.id;
      END IF;
      UPDATE public.notifications SET is_read = true WHERE entity_type = 'order_payment_claim' AND entity_id = p_order_id AND is_read = false;
      RETURN jsonb_build_object(
        'order_id', p_order_id,
        'invoice_id', v_inv.id,
        'paid_amount', v_order.total_amount,
        'due_amount', 0,
        'payment_status', 'paid'
      );
    END IF;
    v_applied_amount := v_due;
  ELSE
    IF v_due <= 0 THEN
      RAISE EXCEPTION 'Order % is already fully paid. Mark Unpaid first if resetting.', v_order.order_number;
    END IF;
    IF p_amount IS NULL OR ROUND(p_amount, 2) <= 0 THEN
      RAISE EXCEPTION 'Partial payment amount must be greater than zero';
    END IF;
    IF ROUND(p_amount, 2) > (v_due + 0.01) THEN
      RAISE EXCEPTION 'Payment amount (₹%) exceeds remaining due balance (₹%)', ROUND(p_amount, 2), v_due;
    END IF;
    v_applied_amount := LEAST(v_due, ROUND(p_amount, 2));
  END IF;

  -- Ensure GST invoice exists for the payment ledger entry
  IF v_inv.id IS NULL THEN
    v_inv_id := public.generate_customer_invoice(p_order_id, 15);
    SELECT * INTO v_inv FROM public.invoices WHERE id = v_inv_id FOR UPDATE;
  END IF;

  INSERT INTO public.payments (
    invoice_id, customer_id, amount, payment_method, reference_number, payment_date, notes, recorded_by
  )
  VALUES (
    v_inv.id, v_order.customer_id, v_applied_amount, p_payment_method,
    NULLIF(trim(COALESCE(p_reference_number, '')), ''), COALESCE(p_payment_date, CURRENT_DATE),
    NULLIF(trim(COALESCE(p_notes, '')), ''), v_actor
  )
  RETURNING id INTO v_pay_id;

  v_new_paid := LEAST(v_order.total_amount, ROUND(v_order.paid_amount + v_applied_amount, 2));
  v_new_due := GREATEST(0::numeric, v_order.total_amount - v_new_paid);

  IF v_new_paid >= v_order.total_amount THEN
    v_new_status := 'paid';
  ELSIF v_new_paid > 0 THEN
    v_new_status := 'partially_paid';
  ELSE
    v_new_status := 'unpaid';
  END IF;

  UPDATE public.invoices SET
    paid_amount = v_new_paid,
    payment_status = v_new_status
  WHERE id = v_inv.id;

  UPDATE public.orders SET
    paid_amount = v_new_paid,
    payment_status = v_new_status
  WHERE id = p_order_id;

  UPDATE public.notifications
  SET is_read = true
  WHERE entity_type = 'order_payment_claim' AND entity_id = p_order_id AND is_read = false;

  IF v_customer.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (recipient_role, recipient_user_id, title, message, entity_type, entity_id)
    VALUES (
      'customer',
      v_customer.user_id,
      'Payment Recorded: ' || v_order.order_number,
      'Payment of ₹' || v_applied_amount::text || ' (' || p_payment_method || ') recorded for order ' || v_order.order_number || '. Total Paid: ₹' || v_new_paid::text || ', Remaining Due: ₹' || v_new_due::text || '.',
      'order',
      p_order_id
    );
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    v_actor,
    CASE WHEN v_new_status = 'paid' THEN 'mark_order_paid' ELSE 'record_partial_order_payment' END,
    'orders',
    p_order_id::text,
    jsonb_build_object('paid_amount', v_order.paid_amount, 'payment_status', v_order.payment_status),
    jsonb_build_object('payment_id', v_pay_id, 'invoice_id', v_inv.id, 'applied_amount', v_applied_amount, 'paid_amount', v_new_paid, 'due_amount', v_new_due, 'payment_status', v_new_status, 'method', p_payment_method, 'reference', p_reference_number)
  );

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'payment_id', v_pay_id,
    'invoice_id', v_inv.id,
    'applied_amount', v_applied_amount,
    'paid_amount', v_new_paid,
    'due_amount', v_new_due,
    'payment_status', v_new_status
  );
END;
$$;

-- Customer Payment Notice RPC: lets customers report UTR / transfer details so Admin gets notified immediately
CREATE OR REPLACE FUNCTION public.submit_customer_payment_notice(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text,
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
  v_order public.orders%ROWTYPE;
  v_due numeric(14,2);
  v_clean_ref text;
  v_notif_id uuid;
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

  SELECT * INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id AND o.customer_id = v_customer.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.order_status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot report payment for a cancelled order';
  END IF;

  v_due := GREATEST(0::numeric, v_order.total_amount - v_order.paid_amount);
  IF v_due <= 0 THEN
    RAISE EXCEPTION 'Order % already has zero due balance', v_order.order_number;
  END IF;

  IF p_amount IS NULL OR ROUND(p_amount, 2) <= 0 OR ROUND(p_amount, 2) > (v_due + 0.01) THEN
    RAISE EXCEPTION 'Reported payment amount must be between ₹0.01 and due balance (₹%)', v_due;
  END IF;

  IF p_payment_method NOT IN ('Bank Transfer', 'UPI', 'NEFT/RTGS', 'Cheque', 'Cash', 'Card') THEN
    RAISE EXCEPTION 'Invalid payment method';
  END IF;

  v_clean_ref := trim(COALESCE(p_reference_number, ''));
  IF length(v_clean_ref) < 2 THEN
    RAISE EXCEPTION 'Transaction reference / UTR number is required';
  END IF;

  INSERT INTO public.notifications (recipient_role, title, message, entity_type, entity_id)
  VALUES (
    'admin',
    'Customer Payment Alert: ' || v_order.order_number,
    v_customer.business_name || ' reported payment of ₹' || ROUND(p_amount, 2)::text ||
      ' via ' || p_payment_method || ' (Ref: ' || v_clean_ref || '). Current Due: ₹' || v_due::text ||
      COALESCE(' — ' || NULLIF(trim(COALESCE(p_notes, '')), ''), ''),
    'order_payment_claim',
    p_order_id
  )
  RETURNING id INTO v_notif_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_user_id, 'customer_payment_notice', 'orders', p_order_id::text,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'customer_id', v_customer.id,
      'reported_amount', ROUND(p_amount, 2),
      'payment_method', p_payment_method,
      'reference_number', v_clean_ref,
      'notes', NULLIF(trim(COALESCE(p_notes, '')), '')
    )
  );

  RETURN jsonb_build_object(
    'notification_id', v_notif_id,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'reported_amount', ROUND(p_amount, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_customer_invoice(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_customer_invoice(uuid, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, numeric, text, text, date, text) TO authenticated;

REVOKE ALL ON FUNCTION public.update_order_payment_admin(uuid, text, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_payment_admin(uuid, text, numeric, text, text, date, text) TO authenticated;

REVOKE ALL ON FUNCTION public.submit_customer_payment_notice(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_customer_payment_notice(uuid, numeric, text, text, text) TO authenticated;
