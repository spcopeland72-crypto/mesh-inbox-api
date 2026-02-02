import Redis from 'ioredis';
import { config } from './env';

const isVercel = process.env.VERCEL === '1';
export const redisClient = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: true,
  connectTimeout: 10000,
  commandTimeout: 5000,
  enableReadyCheck: false,
  enableOfflineQueue: false,
  keepAlive: 30000,
  ...(isVercel ? { enableOfflineQueue: false, maxRetriesPerRequest: 1 } : {}),
});

let connectionPromise: Promise<void> | null = null;
let isConnected = false;

export const connectRedis = async (): Promise<void> => {
  if (isConnected && redisClient.status === 'ready') return Promise.resolve();
  if (connectionPromise) return connectionPromise;

  connectionPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connectionPromise = null;
      reject(new Error('Redis connection timeout after 10 seconds'));
    }, 10000);

    const onConnect = () => { console.log('[MeshInbox] Connecting to Redis...'); };
    const onReady = () => {
      clearTimeout(timeout);
      isConnected = true;
      console.log('[MeshInbox] Redis ready');
      redisClient.removeListener('connect', onConnect);
      redisClient.removeListener('ready', onReady);
      redisClient.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      clearTimeout(timeout);
      connectionPromise = null;
      isConnected = false;
      console.error('[MeshInbox] Redis error:', err.message);
      redisClient.removeListener('connect', onConnect);
      redisClient.removeListener('ready', onReady);
      redisClient.removeListener('error', onError);
      if (config.nodeEnv === 'development') resolve();
      else reject(err);
    };

    redisClient.once('connect', onConnect);
    redisClient.once('ready', onReady);
    redisClient.once('error', onError);

    const status = redisClient.status;
    if (status === 'end' || status === 'close' || status === 'wait') {
      redisClient.connect().catch((err: Error) => {
        clearTimeout(timeout);
        connectionPromise = null;
        redisClient.removeListener('connect', onConnect);
        redisClient.removeListener('ready', onReady);
        redisClient.removeListener('error', onError);
        if (config.nodeEnv === 'development') resolve();
        else reject(err);
      });
    } else if (status === 'ready') {
      clearTimeout(timeout);
      isConnected = true;
      redisClient.removeListener('connect', onConnect);
      redisClient.removeListener('ready', onReady);
      redisClient.removeListener('error', onError);
      resolve();
    }
  });

  return connectionPromise;
};

// Mesh router key layout (same as mesh-router redis-queue)
const QOS_TIERS = ['Q0', 'Q1', 'Q2', 'Q3'] as const;
export type QoSTier = (typeof QOS_TIERS)[number];
export const MESH_KEYS = {
  queue: (continuumId: string, qos: string) => `queue:${continuumId}:${qos}`,
  stats: (continuumId: string) => `stats:${continuumId}`,
  continuumsSet: () => 'continuums:set',
};
export { QOS_TIERS };

// NME shape (same as mesh-router) for continuum message write
export interface NME {
  nme_version: '3.0';
  message_id: string;
  sender: string;
  target: string;
  timestamp: string;
  mode: string;
  urgency: string;
  qos: QoSTier;
  risk_level: string;
  payload: Record<string, unknown>;
  session_id?: string;
  correlation_id?: string;
  ttl?: number;
}

/** Enqueue a continuum message to Redis (same layout as mesh-router MESH.DISPATCH). */
export async function enqueueMessage(
  target: string,
  qos: QoSTier,
  nme: NME
): Promise<void> {
  const queueKey = MESH_KEYS.queue(target, qos);
  await redisClient.rpush(queueKey, JSON.stringify(nme));
  await redisClient.sadd(MESH_KEYS.continuumsSet(), target);
  const statsKey = MESH_KEYS.stats(target);
  await redisClient.hincrby(statsKey, 'messages_received', 1);
  await redisClient.hset(statsKey, 'last_heartbeat', Date.now().toString());
  await redisClient.hset(statsKey, 'status', 'online');
}

/** Update heartbeat for a continuum (register); adds to continuums set. */
export async function updateHeartbeat(continuumId: string): Promise<void> {
  await redisClient.sadd(MESH_KEYS.continuumsSet(), continuumId);
  const statsKey = MESH_KEYS.stats(continuumId);
  await redisClient.hset(statsKey, 'last_heartbeat', Date.now().toString());
  await redisClient.hset(statsKey, 'status', 'online');
}

/** Get stats for one continuum; null if none. */
export async function getStats(continuumId: string): Promise<{
  messages_sent: number;
  messages_received: number;
  last_heartbeat: number;
  status: string;
} | null> {
  const raw = await redisClient.hgetall(MESH_KEYS.stats(continuumId));
  if (Object.keys(raw).length === 0) return null;
  return {
    messages_sent: parseInt(raw.messages_sent || '0', 10),
    messages_received: parseInt(raw.messages_received || '0', 10),
    last_heartbeat: parseInt(raw.last_heartbeat || '0', 10),
    status: raw.status || 'offline',
  };
}
