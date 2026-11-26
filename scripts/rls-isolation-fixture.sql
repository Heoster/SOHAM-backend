-- Synthetic database only; used by the disposable CI Postgres service.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.chat_history (id bigserial PRIMARY KEY, user_id text NOT NULL, content text);
CREATE TABLE public.memories (id text PRIMARY KEY, user_id text NOT NULL);
CREATE TABLE public.user_profiles (user_id text PRIMARY KEY);
CREATE TABLE public.documents (id text PRIMARY KEY, user_id text NOT NULL);
CREATE TABLE public.image_rate_limits (user_id text PRIMARY KEY);
INSERT INTO public.chat_history(user_id, content) VALUES ('test-a', 'synthetic-a'), ('test-b', 'synthetic-b');
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
ALTER TABLE public.chat_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.chat_history USING (true) WITH CHECK (true);
-- Verify that an unknown permissive policy cannot reopen access after lockdown.
CREATE POLICY "another permissive policy" ON public.chat_history USING (true) WITH CHECK (true);
