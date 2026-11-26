DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['chat_history','memories','user_profiles','documents','image_rate_limits'] LOOP
    IF has_table_privilege('anon', 'public.' || target, 'SELECT') OR has_table_privilege('authenticated', 'public.' || target, 'SELECT') THEN
      RAISE EXCEPTION 'Browser role still has private table access: %', target;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || target, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Backend service role lost access: %', target;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = target AND policyname = 'soham deny browser access' AND permissive = 'RESTRICTIVE') THEN
      RAISE EXCEPTION 'Restrictive policy missing: %', target;
    END IF;
  END LOOP;
END $$;
-- Even an accidental SELECT grant must not defeat the restrictive RLS policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_history TO authenticated;
SET ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.chat_history) THEN RAISE EXCEPTION 'RLS leaked private rows'; END IF;
  BEGIN
    INSERT INTO public.chat_history(id, user_id, content) VALUES (9999, 'test-a', 'forged');
    RAISE EXCEPTION 'RLS allowed a forged write';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
UPDATE public.chat_history SET content = 'forged';
DELETE FROM public.chat_history;
RESET ROLE;
SET ROLE service_role;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.chat_history) <> 2 THEN RAISE EXCEPTION 'Rows changed or backend access failed'; END IF;
END $$;
RESET ROLE;
