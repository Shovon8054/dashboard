import express from 'express';
import { acknowledgeEvents } from './service';

const router = express.Router();

/**
 * POST /api/ack
 * Body: { "event_ids": ["id1", "id2", ...] }
 * Returns per‑ID result preserving input order.
 */
router.post('/', async (req, res, next) => {
  try {
    const { event_ids } = req.body ?? {};
    if (!Array.isArray(event_ids) || event_ids.length === 0) {
      const err: any = new Error('event_ids must be a non‑empty array');
      err.status = 400;
      throw err;
    }
    const results = await acknowledgeEvents(event_ids);
    return res.json({ results });
  } catch (e) {
    next(e);
  }
});

export default router;
