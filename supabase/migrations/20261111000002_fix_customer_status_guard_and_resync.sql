-- ============================================================================
-- Migration 007: Allow service_role/postgres updates in guard_customer_self_update
-- and resync desynced customer user/auth status flags
-- ============================================================================

GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION private.guard_customer_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Privileged backend calls (Edge Functions via service_role and internal SQL/migrations)
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

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

GRANT EXECUTE ON FUNCTION private.guard_customer_self_update() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_or_staff() TO authenticated, service_role;

-- Repair any existing customer records where users.is_active or auth.users.banned_until
-- diverged from public.customers.status due to silent guard trigger failures.
UPDATE public.users u
SET is_active = (c.status = 'active')
FROM public.customers c
WHERE c.user_id = u.id
  AND u.is_active IS DISTINCT FROM (c.status = 'active');

UPDATE auth.users au
SET banned_until = NULL,
    updated_at = now()
FROM public.customers c
WHERE c.user_id = au.id
  AND c.status = 'active'
  AND au.banned_until IS NOT NULL;

UPDATE auth.users au
SET banned_until = now() + interval '100 years',
    updated_at = now()
FROM public.customers c
WHERE c.user_id = au.id
  AND c.status <> 'active'
  AND (au.banned_until IS NULL OR au.banned_until <= now());
