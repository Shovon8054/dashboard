import express from 'express';
import cors from 'cors';
import { json } from 'body-parser';
import dotenv from 'dotenv';
import eventsRouter from './modules/events/routes';
import stateRouter from './modules/state/routes';
import ackRouter from './modules/ack/routes';
import mqttRouter from './modules/mqtt/routes';
import { startMqttWorker } from './modules/mqtt/worker';

dotenv.config();

// NorthBridge Production Dashboard API
const app = express();

// Enable CORS for frontend dev server
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(json());

// Mount API routers
app.use('/api/events', eventsRouter);
app.use('/api/state', stateRouter);
app.use('/api/ack', ackRouter);
app.use('/api/mqtt', mqttRouter);

// Central error handling – never expose internal details
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  startMqttWorker();
});

export default app;
