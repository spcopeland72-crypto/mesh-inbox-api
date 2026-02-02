import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { config } from './config/env';
import { redisClient, connectRedis } from './config/redis';
import { errorHandler } from './middleware/errorHandler';
import inboxRoutes, {
  discoverHandler,
  priorityHandler,
  readHandler,
  registerGetHandler,
} from './routes/inbox';
import { getNqp, postNqp } from './routes/nqp';
import { searchHandler } from './routes/search';
import { sendJsonOrHtml } from './utils/responseFormat';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Substrate path aliases: reserved first-path segments (do not treat as continuumId)
const SUBSTRATE_RESERVED = new Set([
  'register', 'discover', 'priority', 'health', 'search', 'api', 'nqp', 'send', 'continuums', 'test',
]);

app.get('/', (_req, res) => {
  res.json({
    service: 'Mesh Inbox API',
    version: '1.0.0',
    status: 'online',
    description: 'Read and write continuum mesh messages (same Redis as mesh router)',
    endpoints: {
      health: '/health',
      search: 'GET /search?q=<command> (web search: read/write via search string)',
      nqp: 'POST /nqp (NQP body), GET /nqp?c=MD&to=&from=&pl= (compact send)',
      register: 'GET /register/:continuumId or POST /api/v1/inbox/register',
      discover: '/discover or /api/v1/inbox/discover',
      send: 'POST /api/v1/inbox/send',
      inbox: '/:continuumId or /api/v1/inbox/:continuumId',
      priority: '/priority/:continuumId or /api/v1/inbox/:continuumId/priority',
      continuums: '/api/v1/inbox/continuums',
      depth: '/api/v1/inbox/:continuumId/depth',
      stats: '/api/v1/inbox/:continuumId/stats',
    },
    spec: '/docs/MESH_ROUTER_FUNCTIONAL_SPEC.md',
    substrate: 'Substrate requirements supported: /nqp, HTML (?format=html), path aliases.',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req: Request, res: Response) => {
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
  const data = {
    status: 'ok',
    service: 'Mesh Inbox API',
    redis: redisStatus,
    redisError,
    timestamp: new Date().toISOString(),
  };
  sendJsonOrHtml(req, res, 'Health', data);
});

app.get('/search', searchHandler);

// NQP (substrate requirement): POST /nqp, GET /nqp?c=MD&to=&from=&pl=
app.post('/nqp', postNqp);
app.get('/nqp', getNqp);

// Substrate path aliases (docs say GET /register/:id, GET /:id, GET /priority/:id, GET /discover)
app.get('/register/:continuumId', registerGetHandler);
app.get('/discover', discoverHandler);
app.get('/priority/:continuumId', priorityHandler);
app.get('/:continuumId', (req: Request, res: Response, next: NextFunction) => {
  if (SUBSTRATE_RESERVED.has(req.params.continuumId ?? '')) return next();
  return readHandler(req, res, next);
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
