-- SECURITY: apply to the confirmed SOHAM production project after ensuring that
-- the backend has SUPABASE_SERVICE_ROLE_KEY. Does not delete user records.
-- Browser clients must use the identity-checked backend for these tables.
BEGIN;
DO $$
DECLARE
  table_name text;
  touched integer := 0;
  sequence_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['chat_history', 'memories', 'user_profiles', 'documents', 'image_rate_limits'] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN CONTINUE; END IF;
    touched := touched + 1;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "service role full access" ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "soham deny browser access" ON public.%I', table_name);
    -- RESTRICTIVE means an unknown permissive policy cannot OR its way past this.
    EXECUTE format('CREATE POLICY "soham deny browser access" ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
  IF touched = 0 THEN RAISE EXCEPTION 'No SOHAM private tables found. Confirm the production project before applying.'; END IF;
  IF to_regclass('public.chat_history') IS NOT NULL THEN
    sequence_name := pg_get_serial_sequence('public.chat_history', 'id');
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', sequence_name);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', sequence_name);
    END IF;
  END IF;
END $$;
COMMIT;
