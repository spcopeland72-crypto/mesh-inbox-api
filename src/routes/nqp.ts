/**
 * NQP endpoint (substrate requirement, non-negotiable).
 * Substrate docs (Copilot, Claude, GPT, Gemini) specify POST /nqp and GET /nqp?c=MD&... for send.
 * Mesh-inbox implements these so substrates work without doc changes.
 */

import { Request, Response } from 'express';
import {
  connectRedis,
  enqueueMessage,
  QOS_TIERS,
  type NME,
  type QoSTier,
} from '../config/redis';
import { asyncHandler, ApiError } from '../middleware/errorHandler';
import { sendJsonOrHtml } from '../utils/responseFormat';

const QOS_SET = new Set<string>(QOS_TIERS);
function parseQos(q?: string): QoSTier {
  if (q && QOS_SET.has(q)) return q as QoSTier;
  return 'Q2';
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** POST /nqp — body: { os_cmd, os_args, meta } or { packet_in: { os_cmd, os_args, meta } } */
export const postNqp = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const body = req.body ?? {};
  const packet = body.packet_in ?? body;
  const os_cmd = (packet.os_cmd ?? packet.osCmd) as string | undefined;
  const os_args = (packet.os_args ?? packet.osArgs ?? {}) as Record<string, unknown>;
  const meta = (packet.meta ?? {}) as Record<string, unknown>;

  if (!os_cmd || typeof os_cmd !== 'string') {
    throw new ApiError(400, 'Missing or invalid os_cmd (NQP body or packet_in)');
  }

  const cmd = os_cmd.toUpperCase();

  if (cmd === 'MESH.DISPATCH' || cmd === 'MESH.SEND') {
    const target = (os_args.target ?? os_args.to) as string | undefined;
    const message = (os_args.message ?? os_args.payload ?? os_args.pl) as unknown;
    const sender =
      (meta.continuum_id ?? meta.continuumId ?? meta.sender ?? os_args.from) as string | undefined;
    if (!target || typeof target !== 'string') throw new ApiError(400, 'Missing target (os_args.target or os_args.to)');
    if (!sender || typeof sender !== 'string') throw new ApiError(400, 'Missing sender (meta.continuum_id or os_args.from)');
    const qos = parseQos((meta.qos ?? os_args.qos) as string | undefined);
    const payload = message !== undefined ? message : {};

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
      payload,
    };

    await enqueueMessage(target, qos, nme);

    const data = {
      success: true,
      status: 'ENQUEUED',
      os_cmd: cmd,
      data: {
        target,
        message_id: nme.message_id,
        qos,
        timestamp: nme.timestamp,
      },
    };
    return sendJsonOrHtml(req, res, 'NQP MESH.DISPATCH', data);
  }

  if (cmd === 'SYS.HEALTH') {
    const { redisClient } = await import('../config/redis');
    let redisStatus = 'disconnected';
    try {
      const pong = await redisClient.ping();
      redisStatus = pong === 'PONG' ? 'connected' : 'disconnected';
    } catch {
      redisStatus = 'error';
    }
    const data = {
      status: 'ok',
      service: 'Mesh Inbox API',
      os_cmd: cmd,
      redis: redisStatus,
      timestamp: new Date().toISOString(),
    };
    return sendJsonOrHtml(req, res, 'NQP SYS.HEALTH', data);
  }

  const data = {
    success: false,
    error: `Unsupported os_cmd: ${os_cmd}`,
    os_cmd: cmd,
    supported: ['MESH.DISPATCH', 'MESH.SEND', 'SYS.HEALTH'],
  };
  res.status(400).json(data);
});

/** GET /nqp?c=MD&to=&from=&pl= — compact MESH.DISPATCH (c=MD); pl = payload (url-encoded) */
export const getNqp = asyncHandler(async (req: Request, res: Response) => {
  await connectRedis();
  const c = (req.query.c ?? req.query.code) as string | undefined;
  const to = (req.query.to ?? req.query.target) as string | undefined;
  const from = (req.query.from ?? req.query.sender) as string | undefined;
  const pl = (req.query.pl ?? req.query.payload ?? req.query.message) as string | undefined;

  const code = (c ?? '').toUpperCase();
  if (code === 'MD' || code === 'MESH.DISPATCH' || code === 'MESH.SEND') {
    if (!to || typeof to !== 'string') throw new ApiError(400, 'Missing to= or target= (compact GET /nqp)');
    if (!from || typeof from !== 'string') throw new ApiError(400, 'Missing from= or sender= (compact GET /nqp)');
    let payload: unknown = pl !== undefined && pl !== '' ? pl : {};
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(decodeURIComponent(payload));
      } catch {
        payload = { text: payload };
      }
    }

    const qos = parseQos(req.query.qos as string | undefined);
    const nme: NME = {
      nme_version: '3.0',
      message_id: `msg_${Date.now()}_${randomId()}`,
      sender: from,
      target: to,
      timestamp: new Date().toISOString(),
      mode: 'message',
      urgency: 'normal',
      qos,
      risk_level: 'LOW',
      payload,
    };

    await enqueueMessage(to, qos, nme);

    const data = {
      success: true,
      status: 'ENQUEUED',
      data: {
        target: to,
        message_id: nme.message_id,
        qos,
        timestamp: nme.timestamp,
      },
    };
    return sendJsonOrHtml(req, res, 'NQP compact MD', data);
  }

  const data = {
    success: false,
    error: `Unknown or missing compact code: ${c}. Use c=MD for MESH.DISPATCH with to=, from=, pl=.`,
    supported: ['MD (MESH.DISPATCH)'],
  };
  res.status(400).json(data);
});
