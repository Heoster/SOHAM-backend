/**
 * User Profile Service
 * ════════════════════════════════════════════════════════════════════════════
 * Stores and retrieves structured personal information for each user,
 * keyed by a unique userId (e.g. Firebase UID).
 *
 * Supabase table: user_profiles
 *
 * What is stored:
 *   - Personal info  : name, age, location, language, timezone
 *   - Preferences    : response style, technical level, tone
 *   - Likes          : topics, foods, hobbies, technologies
 *   - Dislikes       : topics, foods, etc.
 *   - Custom facts   : any key-value pairs extracted from conversation
 *
 * The profile is loaded on every chat request and injected into the
 * system prompt so SOHAM can personalise every response.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserProfile {
  userId: string;

  // Personal information
  name?: string;
  age?: number;
  location?: string;
  language?: string;
  timezone?: string;
  occupation?: string;

  // Communication preferences
  preferredTone?: 'formal' | 'casual' | 'friendly' | 'technical';
  technicalLevel?: 'beginner' | 'intermediate' | 'expert';
  responseLength?: 'concise' | 'detailed' | 'balanced';

  // Interests
  likes: string[];       // topics, foods, hobbies, technologies the user likes
  dislikes: string[];    // things the user dislikes

  // Arbitrary key-value facts ("User is vegetarian", "User uses dark mode")
  customFacts: Record<string, string>;

  createdAt: string;
  updatedAt: string;
}

export interface ProfileUpdatePayload {
  name?: string;
  age?: number;
  location?: string;
  language?: string;
  timezone?: string;
  occupation?: string;
  preferredTone?: UserProfile['preferredTone'];
  technicalLevel?: UserProfile['technicalLevel'];
  responseLength?: UserProfile['responseLength'];
  likes?: string[];
  dislikes?: string[];
  customFacts?: Record<string, string>;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  return { url, key, ready: Boolean(url && key) };
}

async function sbFetch(path: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const { url, key } = getSupabaseConfig();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(tid);
  }
}

// ─── Row ↔ Domain mapping ─────────────────────────────────────────────────────

interface ProfileRow {
  user_id: string;
  name: string | null;
  age: number | null;
  location: string | null;
  language: string | null;
  timezone: string | null;
  occupation: string | null;
  preferred_tone: string | null;
  technical_level: string | null;
  response_length: string | null;
  likes: string[];
  dislikes: string[];
  custom_facts: Record<string, string>;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): UserProfile {
  return {
    userId: row.user_id,
    name: row.name ?? undefined,
    age: row.age ?? undefined,
    location: row.location ?? undefined,
    language: row.language ?? undefined,
    timezone: row.timezone ?? undefined,
    occupation: row.occupation ?? undefined,
    preferredTone: (row.preferred_tone as UserProfile['preferredTone']) ?? undefined,
    technicalLevel: (row.technical_level as UserProfile['technicalLevel']) ?? undefined,
    responseLength: (row.response_length as UserProfile['responseLength']) ?? undefined,
    likes: row.likes ?? [],
    dislikes: row.dislikes ?? [],
    customFacts: row.custom_facts ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emptyProfile(userId: string): UserProfile {
  const now = new Date().toISOString();
  return {
    userId,
    likes: [],
    dislikes: [],
    customFacts: {},
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class UserProfileService {
  private readonly table = 'user_profiles';

  // ── Get or create ──────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const { ready } = getSupabaseConfig();
    if (!ready) return emptyProfile(userId);

    try {
      const res = await sbFetch(
        `${this.table}?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
        { method: 'GET' }
      );
      if (!res.ok) return emptyProfile(userId);

      const rows = (await res.json()) as ProfileRow[];
      if (rows.length === 0) return emptyProfile(userId);
      return rowToProfile(rows[0]);
    } catch {
      return emptyProfile(userId);
    }
  }

  // ── Upsert (create or update) ──────────────────────────────────────────────

  async upsertProfile(userId: string, updates: ProfileUpdatePayload): Promise<UserProfile> {
    const { ready } = getSupabaseConfig();
    if (!ready) return emptyProfile(userId);

    // Fetch existing first so we can merge arrays
    const existing = await this.getProfile(userId);
    const now = new Date().toISOString();

    // Merge likes / dislikes / customFacts (union, no duplicates)
    const mergedLikes = Array.from(new Set([
      ...existing.likes,
      ...(updates.likes ?? []),
    ]));
    const mergedDislikes = Array.from(new Set([
      ...existing.dislikes,
      ...(updates.dislikes ?? []),
    ]));
    const mergedFacts: Record<string, string> = {
      ...existing.customFacts,
      ...(updates.customFacts ?? {}),
    };

    const row: Partial<ProfileRow> & { user_id: string } = {
      user_id: userId,
      name: updates.name ?? existing.name ?? null,
      age: updates.age ?? existing.age ?? null,
      location: updates.location ?? existing.location ?? null,
      language: updates.language ?? existing.language ?? null,
      timezone: updates.timezone ?? existing.timezone ?? null,
      occupation: updates.occupation ?? existing.occupation ?? null,
      preferred_tone: updates.preferredTone ?? existing.preferredTone ?? null,
      technical_level: updates.technicalLevel ?? existing.technicalLevel ?? null,
      response_length: updates.responseLength ?? existing.responseLength ?? null,
      likes: mergedLikes,
      dislikes: mergedDislikes,
      custom_facts: mergedFacts,
      updated_at: now,
    };

    // If profile doesn't exist yet, set created_at
    if (!existing.createdAt || existing.createdAt === now) {
      (row as any).created_at = now;
    }

    try {
      const res = await sbFetch(this.table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });

      if (!res.ok) {
        console.warn('[UserProfile] Upsert failed:', await res.text());
        return existing;
      }

      const rows = (await res.json()) as ProfileRow[];
      return rows.length > 0 ? rowToProfile(rows[0]) : existing;
    } catch (err) {
      console.warn('[UserProfile] Upsert error:', err);
      return existing;
    }
  }

  // ── Merge extracted facts from conversation ────────────────────────────────

  /**
   * Called after memory extraction to update the profile with newly
   * discovered personal information.
   */
  async mergeExtractedFacts(userId: string, facts: ExtractedProfileFacts): Promise<void> {
    const updates: ProfileUpdatePayload = {};

    if (facts.name) updates.name = facts.name;
    if (facts.age) updates.age = facts.age;
    if (facts.location) updates.location = facts.location;
    if (facts.occupation) updates.occupation = facts.occupation;
    if (facts.language) updates.language = facts.language;
    if (facts.likes?.length) updates.likes = facts.likes;
    if (facts.dislikes?.length) updates.dislikes = facts.dislikes;
    if (facts.customFacts && Object.keys(facts.customFacts).length > 0) {
      updates.customFacts = facts.customFacts;
    }

    if (Object.keys(updates).length === 0) return;

    await this.upsertProfile(userId, updates).catch(err =>
      console.warn('[UserProfile] mergeExtractedFacts failed:', err)
    );
  }

  // ── Build prompt context string ────────────────────────────────────────────

  /**
   * Returns a compact string to inject into the system prompt.
   * Only includes fields that are actually set.
   */
  buildProfileContext(profile: UserProfile): string {
    const lines: string[] = [];

    if (profile.name) lines.push(`User's name: ${profile.name}`);
    if (profile.age) lines.push(`User's age: ${profile.age}`);
    if (profile.location) lines.push(`User's location: ${profile.location}`);
    if (profile.occupation) lines.push(`User's occupation: ${profile.occupation}`);
    if (profile.language) lines.push(`User's preferred language: ${profile.language}`);
    if (profile.preferredTone) lines.push(`Preferred tone: ${profile.preferredTone}`);
    if (profile.technicalLevel) lines.push(`Technical level: ${profile.technicalLevel}`);
    if (profile.responseLength) lines.push(`Preferred response length: ${profile.responseLength}`);

    if (profile.likes.length > 0) {
      lines.push(`User likes: ${profile.likes.slice(0, 15).join(', ')}`);
    }
    if (profile.dislikes.length > 0) {
      lines.push(`User dislikes: ${profile.dislikes.slice(0, 10).join(', ')}`);
    }

    const factEntries = Object.entries(profile.customFacts).slice(0, 10);
    for (const [key, value] of factEntries) {
      lines.push(`${key}: ${value}`);
    }

    return lines.join('\n');
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteProfile(userId: string): Promise<void> {
    const { ready } = getSupabaseConfig();
    if (!ready) return;

    await sbFetch(
      `${this.table}?user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    ).catch(err => console.warn('[UserProfile] Delete failed:', err));
  }
}

// ─── Extracted profile facts (output of LLM extraction) ──────────────────────

export interface ExtractedProfileFacts {
  name?: string;
  age?: number;
  location?: string;
  occupation?: string;
  language?: string;
  likes?: string[];
  dislikes?: string[];
  customFacts?: Record<string, string>;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: UserProfileService | null = null;

export function getUserProfileService(): UserProfileService {
  if (!_instance) _instance = new UserProfileService();
  return _instance;
}
