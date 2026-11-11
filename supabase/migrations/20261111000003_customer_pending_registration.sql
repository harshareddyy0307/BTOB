-- ============================================================================
-- Migration 008: Support pending customer self-registration awaiting admin approval
-- ============================================================================

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_status_check;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_status_check
  CHECK (status IN ('pending', 'active', 'inactive', 'suspended'));
