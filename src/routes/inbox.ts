import { Router, Request, Response } from 'express';
import {
  redisClient,
  connectRedis,
  MESH_KEYS,
  QOS_TIERS,
  enqueueMessage,
  type NME,
  type QoSTier,
} from '../config/redis';
import { asyncHandler, ApiError } from '../middleware/errorHandler';

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
  const pl = payload != null && typeof payload === 'object' ? payload : {};
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

// Read next message for continuum (dequeue, same as mesh router). Q0 > Q1 > Q2 > Q3
router.get('/:continuumId', asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const { continuumId } = req.params;
  if (!continuumId) throw new ApiError(400, 'Missing continuumId');

  for (const qos of QOS_TIERS) {
    const key = MESH_KEYS.queue(continuumId, qos);
    const raw = await redisClient.lpop(key);
    if (raw) {
      try {
        const nme = JSON.parse(raw);
        const statsKey = MESH_KEYS.stats(continuumId);
        await redisClient.hincrby(statsKey, 'messages_sent', 1);
        await redisClient.hset(statsKey, 'last_heartbeat', Date.now().toString());
        res.json({ success: true, message: nme, empty: false });
        return;
      } catch {
        // skip bad entry
      }
    }
  }
  res.json({ success: true, message: null, empty: true });
}));

// Queue depth per QoS (no dequeue)
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

// Stats for continuum (from stats:{continuumId} hash)
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

export default router;
