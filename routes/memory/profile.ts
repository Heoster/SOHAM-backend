/**
 * User Profile Routes
 *
 * GET  /api/memory/profile/:userId   → Fetch a user's profile
 * POST /api/memory/profile/:userId   → Create or update a user's profile
 * DELETE /api/memory/profile/:userId → Delete a user's profile
 */

import type { Request, Response } from 'express';
import { getUserProfileService } from '../../memory/user-profile-service';
import type { ProfileUpdatePayload } from '../../memory/user-profile-service';

// ── GET /api/memory/profile/:userId ──────────────────────────────────────────

export async function getProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    if (!userId || userId.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_USER_ID', message: 'userId param is required' });
      return;
    }

    const service = getUserProfileService();
    const profile = await service.getProfile(userId.trim());

    res.json({ success: true, profile });
  } catch (error) {
    console.error('[Profile API] GET error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── POST /api/memory/profile/:userId ─────────────────────────────────────────

export async function upsertProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    if (!userId || userId.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_USER_ID', message: 'userId param is required' });
      return;
    }

    const updates: ProfileUpdatePayload = req.body ?? {};

    // Basic validation
    if (updates.age !== undefined && (typeof updates.age !== 'number' || updates.age < 0 || updates.age > 130)) {
      res.status(400).json({ error: 'INVALID_AGE', message: 'age must be a number between 0 and 130' });
      return;
    }
    if (updates.preferredTone && !['formal', 'casual', 'friendly', 'technical'].includes(updates.preferredTone)) {
      res.status(400).json({ error: 'INVALID_TONE', message: 'preferredTone must be formal | casual | friendly | technical' });
      return;
    }
    if (updates.technicalLevel && !['beginner', 'intermediate', 'expert'].includes(updates.technicalLevel)) {
      res.status(400).json({ error: 'INVALID_LEVEL', message: 'technicalLevel must be beginner | intermediate | expert' });
      return;
    }

    const service = getUserProfileService();
    const profile = await service.upsertProfile(userId.trim(), updates);

    res.json({ success: true, profile });
  } catch (error) {
    console.error('[Profile API] POST error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ── DELETE /api/memory/profile/:userId ───────────────────────────────────────

export async function deleteProfileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params;
    if (!userId || userId.trim().length === 0) {
      res.status(400).json({ error: 'MISSING_USER_ID', message: 'userId param is required' });
      return;
    }

    const service = getUserProfileService();
    await service.deleteProfile(userId.trim());

    res.json({ success: true, message: `Profile for user ${userId} deleted` });
  } catch (error) {
    console.error('[Profile API] DELETE error:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
