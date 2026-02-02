import express from 'express';
import cors from 'cors';
import { config } from './config/env';
import { redisClient, connectRedis } from './config/redis';
import { errorHandler } from './middleware/errorHandler';
import inboxRoutes from './routes/inbox';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    service: 'Mesh Inbox API',
    version: '1.0.0',
    status: 'online',
    description: 'Read continuum inboxes from mesh Redis (queue:{continuumId}:{qos})',
    endpoints: {
      health: '/health',
      continuums: '/api/v1/inbox/continuums',
      inbox: '/api/v1/inbox/:continuumId',
      depth: '/api/v1/inbox/:continuumId/depth',
      stats: '/api/v1/inbox/:continuumId/stats',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (_req, res) => {
  let redisStatus = 'disconnected';
  let redisError: string | null = null;
  try {
    await connectRedis();
    const pong = await redisClient.ping();
    redisStatus = pong === 'PONG' ? 'connected' : 'disconnected';
  } catch (e: unknown) {
    redisStatus = 'error';
    redisError = e instanceof Error ? e.message : String(e);
  }
  res.json({
    status: 'ok',
    service: 'Mesh Inbox API',
    redis: redisStatus,
    redisError,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/v1/inbox', inboxRoutes);

app.use(errorHandler);

if (!process.env.VERCEL) {
  const start = async () => {
    try {
      await connectRedis();
      console.log('[MeshInbox] Redis connected');
      app.listen(config.port, () => {
        console.log(`[MeshInbox] Listening on port ${config.port}`);
      });
    } catch (e) {
      console.error('[MeshInbox] Startup failed:', e);
      process.exit(1);
    }
  };
  start();
} else {
  console.log('[MeshInbox] Vercel - Redis connects on first use');
}

export default app;
