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
export const MESH_KEYS = {
  queue: (continuumId: string, qos: string) => `queue:${continuumId}:${qos}`,
  stats: (continuumId: string) => `stats:${continuumId}`,
  continuumsSet: () => 'continuums:set',
};
export { QOS_TIERS };
