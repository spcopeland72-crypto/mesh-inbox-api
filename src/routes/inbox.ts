import { Router, Request, Response } from 'express';
import { redisClient, connectRedis, MESH_KEYS, QOS_TIERS } from '../config/redis';
import { asyncHandler, ApiError } from '../middleware/errorHandler';

const router = Router();

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
