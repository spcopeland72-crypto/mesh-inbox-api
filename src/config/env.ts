// Mesh Inbox API - same Redis as mesh router (continuum inboxes). Not Canny Carrot Redis.

export const config = {
  port: parseInt(process.env.PORT || '3002', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Mesh router Redis (continuum inboxes: queue:{continuumId}:{qos}, stats:{continuumId}, continuums:set)
  redisUrl: process.env.MESH_REDIS_URL || process.env.REDIS_URL || '',
};
