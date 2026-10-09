import express from 'express';
import { processEvent, processBatch } from './service';

const router = express.Router();

/**
 * POST /api/events
 * Accepts a single event object or an array of events.
 * Returns results in the same order as the input.
 */
router.post('/', async (req, res, next) => {
  try {
    const payload = req.body;
    if (Array.isArray(payload)) {
      // Batch processing – keep order
      const results = await processBatch(payload);
      const formatted = results.map((r) => ({
        event_id: r.event_id,
        status: r.status,
        message: r.reason ?? null,
      }));
      return res.json({ results: formatted });
    }
    if (payload && typeof payload === 'object') {
      const result = await processEvent(payload);
      const formatted = [{
        event_id: result.event_id,
        status: result.status,
        message: result.reason ?? null,
      }];
      return res.json({ results: formatted });
    }
    // Invalid top‑level payload
    const err: any = new Error('Request body must be an object or an array of objects');
    err.status = 400;
    throw err;
  } catch (e) {
    next(e);
  }
});

export default router;
