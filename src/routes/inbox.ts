import { Router, Request, Response } from 'express';
import {
  redisClient,
  connectRedis,
  MESH_KEYS,
  QOS_TIERS,
  enqueueMessage,
  updateHeartbeat,
  getStats,
  clearMeshInbox,
  type NME,
  type QoSTier,
} from '../config/redis';
import { asyncHandler, ApiError } from '../middleware/errorHandler';
import { sendJsonOrHtml } from '../utils/responseFormat';

const router = Router();

const QOS_SET = new Set<string>(QOS_TIERS);
function parseQos(q?: string): QoSTier {
  if (q && QOS_SET.has(q)) return q as QoSTier;
  return 'Q2';
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 11);
}

// Write: send continuum message (same Redis layout as mesh-router MESH.DISPATCH)
router.post('/send', asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { target, sender, payload, qos: qosParam } = req.body ?? {};
  if (!target || typeof target !== 'string') throw new ApiError(400, 'Missing or invalid "target"');
  if (!sender || typeof sender !== 'string') throw new ApiError(400, 'Missing or invalid "sender"');
  const pl = payload !== undefined ? payload : {};
  const qos = parseQos(qosParam);

  const nme: NME = {
    nme_version: '3.0',
    message_id: `msg_${Date.now()}_${randomId()}`,
    sender,
    target,
    timestamp: new Date().toISOString(),
    mode: 'message',
    urgency: 'normal',
    qos,
    risk_level: 'LOW',
    payload: pl,
  };

  await enqueueMessage(target, qos, nme);
  res.status(200).json({
    success: true,
    status: 'ENQUEUED',
    data: {
      target,
      message_id: nme.message_id,
      qos,
      timestamp: nme.timestamp,
    },
  });
}));

// List continuum IDs (from continuums:set)
router.get('/continuums', asyncHandler(async (_req: Request, res: Response) => {
  await connectRedis();
  const ids = await redisClient.smembers(MESH_KEYS.continuumsSet());
  res.json({ success: true, continuums: ids });
  return;
}));

const DISCOVER_TIMEOUT_MS = 60000;

// Test: clear all mesh inbox data so tests run against fresh data
router.post('/test/clear', asyncHandler(async (_req: Request, res: Response) => {
  await connectRedis();
  await clearMeshInbox();
  res.json({ success: true, message: 'Mesh inbox cleared.' });
}));

// Discover: list continuums with heartbeat within timeout (spec §2.2). HTML for substrate (GPT).
const discoverHandler = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const timeoutMs = Math.min(
    Math.max(parseInt(String(req.query.timeoutMs), 10) || DISCOVER_TIMEOUT_MS, 1000),
    300000
  );
  const now = Date.now();
  const ids = await redisClient.smembers(MESH_KEYS.continuumsSet());
  const continuums: Array<{
    continuumId: string;
    status: string;
    last_heartbeat: string;
    messages_sent: number;
    messages_received: number;
  }> = [];
  for (const id of ids) {
    const stats = await getStats(id);
    if (!stats) continue;
    if (now - stats.last_heartbeat > timeoutMs) continue;
    continuums.push({
      continuumId: id,
      status: stats.status,
      last_heartbeat: new Date(stats.last_heartbeat).toISOString(),
      messages_sent: stats.messages_sent,
      messages_received: stats.messages_received,
    });
  }
  const data = { success: true, continuums, total: continuums.length };
  sendJsonOrHtml(req, res, 'Discover', data);
});
router.get('/discover', discoverHandler);

// Register: heartbeat so continuum appears in discover. POST is correct (state change); GET kept for web search / backward compat.
router.post('/register', asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const continuumId = req.body?.continuumId ?? req.body?.continuum_id;
  if (!continuumId || typeof continuumId !== 'string') throw new ApiError(400, 'Missing or invalid continuumId (body: { continuumId } or { continuum_id })');
  await updateHeartbeat(continuumId);
  res.json({
    success: true,
    continuumId,
    status: 'registered',
    message: 'Continuum registered. You will appear in /discover for 60 seconds.',
    registeredAt: new Date().toISOString(),
  });
}));
const registerGetHandler = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const continuumId = req.params.continuumId;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');
  await updateHeartbeat(continuumId);
  const data = {
    success: true,
    continuumId,
    status: 'registered',
    message: 'Continuum registered. You will appear in /discover for 60 seconds.',
    registeredAt: new Date().toISOString(),
  };
  sendJsonOrHtml(req, res, 'Register', data);
});
router.get('/register/:continuumId', registerGetHandler);

// ——— Same order as c853015 (working): read, then depth, then stats ———
// Read next message (dequeue Q0→Q1→Q2→Q3). Spec: return exactly what was written; no transformation. HTML for substrate (GPT).
const readHandler = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { continuumId } = req.params;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');

  for (const qos of QOS_TIERS) {
    const key = MESH_KEYS.queue(continuumId, qos);
    const raw = await redisClient.lpop(key);
    if (raw != null && raw !== '') {
      const str = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
      const nme = JSON.parse(str) as Record<string, unknown>;
      const statsKey = MESH_KEYS.stats(continuumId);
      await redisClient.hincrby(statsKey, 'messages_sent', 1);
      await redisClient.hset(statsKey, 'last_heartbeat', Date.now().toString());
      const data = { success: true, message: nme, empty: false };
      sendJsonOrHtml(req, res, 'Inbox', data);
      return;
    }
  }
  const data = { success: true, message: null, empty: true };
  sendJsonOrHtml(req, res, 'Inbox', data);
});
router.get('/:continuumId', readHandler);

// Queue depth per QoS (no dequeue) — same as c853015
router.get('/:continuumId/depth', asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { continuumId } = req.params;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');

  const depth: Record<string, number> = {};
  for (const qos of QOS_TIERS) {
    depth[qos] = await redisClient.llen(MESH_KEYS.queue(continuumId, qos));
  }
  res.json({ success: true, continuumId, depth });
}));

// Stats for continuum — same inline hgetall as c853015 (no getStats)
router.get('/:continuumId/stats', asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { continuumId } = req.params;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');
  const raw = await redisClient.hgetall(MESH_KEYS.stats(continuumId));
  const stats = Object.keys(raw).length
    ? {
        messages_sent: parseInt(raw.messages_sent || '0', 10),
        messages_received: parseInt(raw.messages_received || '0', 10),
        last_heartbeat: parseInt(raw.last_heartbeat || '0', 10),
        status: raw.status || 'offline',
      }
    : null;
  res.json({ success: true, continuumId, stats });
}));

// Priority read (Q0 only). Spec: return exactly what was written; no transformation. HTML for substrate (GPT).
const priorityHandler = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { continuumId } = req.params;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');
  const key = MESH_KEYS.queue(continuumId, 'Q0');
  const raw = await redisClient.lpop(key);
  if (raw != null && raw !== '') {
    const str = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
    const nme = JSON.parse(str) as Record<string, unknown>;
    const statsKey = MESH_KEYS.stats(continuumId);
    await redisClient.hincrby(statsKey, 'messages_sent', 1);
    await redisClient.hset(statsKey, 'last_heartbeat', Date.now().toString());
    const data = { success: true, message: nme, empty: false };
    sendJsonOrHtml(req, res, 'Priority', data);
    return;
  }
  const data = { success: true, message: null, empty: true };
  sendJsonOrHtml(req, res, 'Priority', data);
});
router.get('/:continuumId/priority', priorityHandler);

export default router;
export { discoverHandler, registerGetHandler, readHandler, priorityHandler };
