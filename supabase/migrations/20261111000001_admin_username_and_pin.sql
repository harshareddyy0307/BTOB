-- ============================================================================
-- Migration 006: Admin Login Username & 4-Digit Security PIN Authentication
-- ============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS username text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_username_format_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_username_format_check
      CHECK (username IS NULL OR username ~ '^[a-z0-9._-]{3,32}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON public.users (lower(username))
  WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.admin_security_pins (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_security_pins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_security_pins FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'admin_security_pins'
      AND policyname = 'Service role only deny direct client access'
  ) THEN
    CREATE POLICY "Service role only deny direct client access"
      ON public.admin_security_pins
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_admin_security_pins_updated_at'
      AND tgrelid = 'public.admin_security_pins'::regclass
  ) THEN
    CREATE TRIGGER trg_admin_security_pins_updated_at
      BEFORE UPDATE ON public.admin_security_pins
      FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
  END IF;
END $$;
