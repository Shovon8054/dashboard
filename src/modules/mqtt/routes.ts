import express from 'express';
import { getMqttStatus } from './service';

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const data = await getMqttStatus();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
