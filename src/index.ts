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

// Root route – same homescreen as mesh-router with Redis health monitor
app.get('/', async (_req, res) => {
  try {
    let redisStatus = {
      active: true,
      connected: false,
      verified: false,
      queueType: 'redis' as const,
      message: 'Redis not connected',
    };
    try {
      await connectRedis();
      const pong = await redisClient.ping();
      redisStatus.connected = pong === 'PONG';
      if (redisStatus.connected) {
        try {
          await redisClient.setex('mesh-inbox:homepage:test', 5, 'ok');
          redisStatus.verified = true;
          redisStatus.message = 'Redis connected and verified';
        } catch {
          redisStatus.message = 'Redis connected but test write failed';
        }
      } else {
        redisStatus.message = 'Redis ping failed';
      }
    } catch (e) {
      redisStatus.connected = false;
      redisStatus.verified = false;
      redisStatus.message = e instanceof Error ? e.message : 'Redis connection error';
    }

    const redisBadge = redisStatus.verified
      ? '<span class="badge badge-success">🟢 Redis Active & Verified</span>'
      : redisStatus.connected
        ? '<span class="badge badge-warning">🟡 Redis Connected</span>'
        : '<span class="badge badge-error">🔴 Redis Not Connected</span>';

    const redisStatusBg = redisStatus.verified
      ? 'rgba(34, 197, 94, 0.25)'
      : redisStatus.connected
        ? 'rgba(234, 179, 8, 0.25)'
        : 'rgba(239, 68, 68, 0.25)';
    const redisStatusBorder = redisStatus.verified
      ? 'rgba(34, 197, 94, 0.5)'
      : redisStatus.connected
        ? 'rgba(234, 179, 8, 0.5)'
        : 'rgba(239, 68, 68, 0.5)';

    res.type('text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Newton Mesh Inbox</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      background-attachment: fixed;
      min-height: 100vh;
      width: 100vw;
      color: #ffffff;
      position: relative;
      overflow-x: hidden;
    }
    .content {
      position: absolute;
      bottom: 40px;
      left: 40px;
      max-width: 620px;
      font-size: 14px;
      line-height: 1.5;
    }
    h1 { color: #ffffff; margin-bottom: 8px; font-size: 24px; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }
    h2 { color: #ffffff; font-size: 18px; margin-top: 16px; margin-bottom: 8px; text-shadow: 1px 1px 3px rgba(0,0,0,0.5); }
    .status {
      background: rgba(15, 23, 42, 0.85);
      padding: 12px 16px;
      border-radius: 6px;
      margin: 8px 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #ffffff;
      backdrop-filter: blur(10px);
      font-size: 13px;
    }
    .redis-status {
      background: ${redisStatusBg};
      padding: 10px 14px;
      border-radius: 6px;
      margin: 8px 0;
      border: 2px solid ${redisStatusBorder};
      font-weight: 500;
      color: #ffffff;
      backdrop-filter: blur(10px);
      font-size: 12px;
    }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 6px; text-shadow: none; }
    .badge-success { background: rgba(34, 197, 94, 0.3); color: #fff; border: 1px solid rgba(34, 197, 94, 0.6); }
    .badge-warning { background: rgba(234, 179, 8, 0.3); color: #fff; border: 1px solid rgba(234, 179, 8, 0.6); }
    .badge-error { background: rgba(239, 68, 68, 0.3); color: #fff; border: 1px solid rgba(239, 68, 68, 0.6); }
    .endpoint {
      background: rgba(15, 23, 42, 0.85);
      padding: 8px 12px;
      margin: 6px 0;
      border-left: 3px solid #60a5fa;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      color: #ffffff;
      backdrop-filter: blur(10px);
      font-size: 12px;
    }
    code { background: rgba(0,0,0,0.4); padding: 2px 4px; border-radius: 3px; font-family: Monaco, monospace; color: #fff; font-size: 11px; }
    .redis-details { font-size: 11px; color: rgba(255,255,255,0.9); margin-top: 6px; }
    a { color: #93c5fd; text-decoration: none; font-size: 12px; }
    a:hover { color: #dbeafe; text-decoration: underline; }
    strong { color: #ffffff; }
    em { color: rgba(255,255,255,0.9); font-size: 11px; }
    p { font-size: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="content">
    <h1>📬 Newton Mesh Inbox</h1>
    <div class="status">
      <strong>Status:</strong> ✅ Online<br>
      <strong>Version:</strong> 1.0.0<br>
      <strong>Protocol:</strong> NQP-compatible inbox (read/write, substrate aliases, web search)
    </div>
    <div class="redis-status">
      <strong>Queue Status:</strong> ${redisBadge}
      <div class="redis-details">
        <strong>Type:</strong> REDIS |
        <strong>Connection:</strong> ${redisStatus.connected ? '✅ Connected' : '❌ Not Connected'} |
        <strong>Verified:</strong> ${redisStatus.verified ? '✅ Yes' : '❌ No'}<br>
        <em>${redisStatus.message}</em>
      </div>
    </div>
    <h2>Endpoints</h2>
    <div class="endpoint"><strong>GET /health</strong> – Service and Redis status</div>
    <div class="endpoint"><strong>GET /discover</strong> – Available mesh nodes (heartbeats)</div>
    <div class="endpoint"><strong>POST /nqp</strong> – NQP send (MESH.DISPATCH, SYS.HEALTH)</div>
    <div class="endpoint"><strong>GET /nqp?c=MD&to=&from=&pl=</strong> – Compact send</div>
    <div class="endpoint"><strong>GET /register/:continuumId</strong> – Register / heartbeat</div>
    <div class="endpoint"><strong>GET /:continuumId</strong> – Read next message</div>
    <div class="endpoint"><strong>GET /priority/:continuumId</strong> – Read Q0 only</div>
    <div class="endpoint"><strong>GET /search?q=...</strong> – Web search DSL (read/write)</div>
    <div class="endpoint"><strong>POST /api/v1/inbox/send</strong> – Send message</div>
    <div class="endpoint"><strong>GET /api/v1/inbox/:continuumId</strong> – Inbox read</div>
    <p><a href="/health">View Health Status</a> | <a href="/discover">Discover Nodes</a></p>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('[MeshInbox] Homepage error:', error);
    res.type('text/html');
    res.status(500).send(`<!DOCTYPE html>
<html lang="en">
<head><title>Mesh Inbox – Error</title><meta charset="utf-8"></head>
<body style="font-family:system-ui;padding:2rem;background:#0f172a;color:#fff;">
  <h1>⚠️ Inbox Error</h1>
  <p>Unable to load status. Please check <a href="/health" style="color:#93c5fd;">/health</a>.</p>
</body>
</html>`);
  }
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
