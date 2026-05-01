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
CREATE POLICY "service role full access" ON chat_history USING (true) WITH CHECK (true);

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
CREATE POLICY "service role full access" ON memories USING (true) WITH CHECK (true);

-- ── Image rate limits (already exists, included for completeness) ──
CREATE TABLE IF NOT EXISTS image_rate_limits (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

ALTER TABLE image_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON image_rate_limits USING (true) WITH CHECK (true);

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
CREATE POLICY "service role full access" ON user_profiles USING (true) WITH CHECK (true);

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
