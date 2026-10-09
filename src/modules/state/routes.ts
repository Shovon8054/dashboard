import express from 'express';
import { getSummary, getPending, getExceptions } from './queries';

const router = express.Router();

/**
 * GET /api/state
 * Query params: source_id (optional), view=summary|pending|exceptions (default summary)
 */
router.get('/', async (req, res, next) => {
  try {
    const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : undefined;
    const view = typeof req.query.view === 'string' ? req.query.view : 'summary';
    if (view === 'summary') {
      const data = await getSummary(sourceId);
      return res.json(data);
    }
    if (view === 'pending') {
      const data = await getPending(sourceId);
      return res.json({ pending: data });
    }
    if (view === 'exceptions') {
      const data = await getExceptions(sourceId);
      return res.json({ exceptions: data });
    }
    const err: any = new Error('Invalid view parameter');
    err.status = 400;
    throw err;
  } catch (e) {
    next(e);
  }
});

export default router;
