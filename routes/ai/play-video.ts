/**
 * POST /api/ai/play-video
 * ════════════════════════════════════════════════════════════════════════════
 * Resolve "play <something>" to a concrete YouTube video.
 *
 * Request body (one of query / message required):
 * ┌──────────────┬──────────┬────────────────────────────────────────────────┐
 * │ query        │ string   │ What to play, e.g. "lofi hip hop radio"        │
 * │ message      │ string   │ Full user message, e.g. "soham can you play X" │
 * └──────────────┴──────────┴────────────────────────────────────────────────┘
 *
 * Response (200, ok=true):
 *   { success, ok, tool, query, title, channel, videoId,
 *     watchUrl, embedUrl, thumbnailUrl, searchUrl, source, searchTimeMs,
 *     candidates[], playback: { preferred: 'embed', embedUrl,
 *                               fallback: 'open_in_tab', openInTab: watchUrl } }
 *
 * Response (200, ok=false):
 *   { success, ok: false, query, searchUrl, candidates: [], error,
 *     playback: { preferred: 'open_in_tab', openInTab: searchUrl } }
 *
 * Note for clients: YouTube iframes that disallow embedding fail silently
 * (cross-origin — no JS error event). Always render an "Open in YouTube"
 * fallback action next to the iframe using playback.openInTab.
 */

import type { Request, Response } from 'express';
import { extractPlayQuery, playYouTubeVideo, sanitizePlayQuery } from '../../tools/youtube-play';

export async function playVideoHandler(req: Request, res: Response): Promise<void> {
  try {
    const { query, message } = req.body ?? {};

    if (query !== undefined && typeof query !== 'string') {
      res.status(400).json({ error: 'INVALID_QUERY', message: 'query must be a string' });
      return;
    }
    if (message !== undefined && typeof message !== 'string') {
      res.status(400).json({ error: 'INVALID_MESSAGE', message: 'message must be a string' });
      return;
    }

    // Accept a raw "query", or a full chat message we extract the play target from.
    let effective = typeof query === 'string' ? sanitizePlayQuery(query) : '';
    if (!effective && typeof message === 'string') {
      effective = extractPlayQuery(message) ?? sanitizePlayQuery(message);
    }

    if (!effective) {
      res.status(400).json({
        error: 'MISSING_QUERY',
        message: 'Provide "query" (what to play) or "message" (e.g. "play lofi hip hop")',
        example: { query: 'lofi hip hop radio' },
      });
      return;
    }

    const result = await playYouTubeVideo(effective);

    if (!result.ok) {
      res.json({
        success: true,
        ok: false,
        tool: 'play_video',
        query: result.query,
        searchUrl: result.searchUrl,
        candidates: [],
        error: result.error ?? 'No playable video found.',
        searchTimeMs: result.searchTimeMs,
        playback: {
          preferred: 'open_in_tab',
          openInTab: result.searchUrl, // last-resort: open the YouTube search page
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      ok: true,
      tool: 'play_video',
      query: result.query,
      videoId: result.videoId,
      title: result.title,
      channel: result.channel,
      watchUrl: result.watchUrl,
      embedUrl: result.embedUrl,
      thumbnailUrl: result.thumbnailUrl,
      searchUrl: result.searchUrl,
      source: result.source,
      searchTimeMs: result.searchTimeMs,
      candidates: result.candidates,
      playback: {
        preferred: 'embed',
        embedUrl: result.embedUrl,
        fallback: 'open_in_tab',
        openInTab: result.watchUrl,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'PLAY_VIDEO_FAILED',
      message: error instanceof Error ? error.message : 'Failed to resolve a YouTube video',
    });
  }
}
