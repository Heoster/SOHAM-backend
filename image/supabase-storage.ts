/**
 * Supabase Storage — Image Upload Helper
 *
 * Uploads a base64 data URL to the `generated-images` bucket and returns
 * a permanent public HTTPS URL.  This avoids passing large base64 blobs
 * through Next.js Server Actions or JSON responses.
 *
 * Bucket: generated-images (public, 10 MB limit)
 * Path:   generated/{userId}/{timestamp}-{random}.{ext}
 *
 * Required env vars (already in server/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const BUCKET = 'generated-images';

/**
 * Upload a base64 data URL to Supabase Storage.
 * Returns the permanent public URL, or throws on failure.
 */
export async function uploadImageToSupabase(
  dataUrl: string,
  userId: string
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
  }

  // Parse the data URL  →  data:image/jpeg;base64,/9j/...
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid data URL format');

  const mimeType = match[1];                          // e.g. "image/jpeg"
  const base64   = match[2];
  const ext      = mimeType.split('/')[1].replace('jpeg', 'jpg'); // jpg | png | webp

  // Build a unique path
  const ts     = Date.now();
  const rand   = Math.random().toString(36).slice(2, 8);
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const path   = `generated/${safeId}/${ts}-${rand}.${ext}`;

  // Convert base64 → binary buffer
  const binary = Buffer.from(base64, 'base64');

  // Upload via Supabase Storage REST API
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`;

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': mimeType,
      'x-upsert': 'true',
    },
    body: binary,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Supabase Storage upload failed ${res.status}: ${err.slice(0, 200)}`);
  }

  // Return the public URL
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
}
