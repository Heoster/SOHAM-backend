-- ============================================================
-- SOHAM Memory System — Supabase Table Setup
-- Run this once in your Supabase SQL editor
-- ============================================================

-- ── Short-term: Chat history (cross-device session memory) ──
CREATE TABLE IF NOT EXISTS chat_history (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_history_user_id_idx ON chat_history (user_id, created_at DESC);

ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON chat_history;
DROP POLICY IF EXISTS "soham deny browser access" ON chat_history;
CREATE POLICY "soham deny browser access" ON chat_history AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE chat_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chat_history TO service_role;

-- ── Long-term: Extracted memories (facts, preferences, skills) ──
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  content         TEXT NOT NULL,
  embedding       JSONB NOT NULL DEFAULT '[]',
  category        TEXT NOT NULL DEFAULT 'CONVERSATION'
                    CHECK (category IN ('PREFERENCE','FACT','CONTEXT','SKILL','CONVERSATION')),
  importance      FLOAT NOT NULL DEFAULT 0.5,
  tags            JSONB NOT NULL DEFAULT '[]',
  related_ids     JSONB NOT NULL DEFAULT '[]',
  access_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memories_user_id_idx       ON memories (user_id);
CREATE INDEX IF NOT EXISTS memories_category_idx      ON memories (user_id, category);
CREATE INDEX IF NOT EXISTS memories_last_accessed_idx ON memories (user_id, last_accessed DESC);
CREATE INDEX IF NOT EXISTS memories_importance_idx    ON memories (user_id, importance DESC);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON memories;
DROP POLICY IF EXISTS "soham deny browser access" ON memories;
CREATE POLICY "soham deny browser access" ON memories AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE memories FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE memories TO service_role;

-- ── Image rate limits (already exists, included for completeness) ──
CREATE TABLE IF NOT EXISTS image_rate_limits (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

ALTER TABLE image_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON image_rate_limits;
DROP POLICY IF EXISTS "soham deny browser access" ON image_rate_limits;
CREATE POLICY "soham deny browser access" ON image_rate_limits AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE image_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE image_rate_limits TO service_role;

-- ── User Profiles (structured personal info, preferences, likes/dislikes) ──
-- Run this once in your Supabase SQL editor to enable the User Profile feature.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id          TEXT PRIMARY KEY,
  name             TEXT,
  age              INTEGER,
  location         TEXT,
  language         TEXT,
  timezone         TEXT,
  occupation       TEXT,
  preferred_tone   TEXT CHECK (preferred_tone IN ('formal','casual','friendly','technical')),
  technical_level  TEXT CHECK (technical_level IN ('beginner','intermediate','expert')),
  response_length  TEXT CHECK (response_length IN ('concise','detailed','balanced')),
  likes            JSONB NOT NULL DEFAULT '[]',
  dislikes         JSONB NOT NULL DEFAULT '[]',
  custom_facts     JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_profiles_user_id_idx ON user_profiles (user_id);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON user_profiles;
DROP POLICY IF EXISTS "soham deny browser access" ON user_profiles;
CREATE POLICY "soham deny browser access" ON user_profiles AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE user_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE user_profiles TO service_role;

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_user_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_user_profiles_updated_at();

-- ── Documents (Document RAG) ──────────────────────────────────────────────────
-- Registry of user-uploaded documents. The chunks themselves live in Pinecone
-- Vector (namespace "docs"); chunk_ids records them so DELETE can remove both.
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error         TEXT,
  truncated     BOOLEAN NOT NULL DEFAULT FALSE,
  chunk_ids     JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents (user_id, created_at DESC);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role full access" ON documents;
DROP POLICY IF EXISTS "soham deny browser access" ON documents;
CREATE POLICY "soham deny browser access" ON documents AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE documents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE documents TO service_role;
