/**
 * Web search endpoint: parse search query as AIIS OS command, execute read/write, return HTML + JSON.
 * For substrates that only have web_search() (e.g. Gemini, some GPT). Mesh-inbox is the working replacement for the scrapped router.
 *
 * DSL: "mesh-inbox" "operation" "parameters"
 * Or: mesh-inbox-api.vercel.app "operation" "parameters"
 *
 * Operations:
 *   MESH.DISPATCH / MESH.SEND - write (to: target, from: sender, message: text, qos: Q0|Q1|Q2|Q3)
 *   MESH.POLL - read next message (continuum_id: id)
 *   MESH.POLL.PRIORITY - read Q0 only (continuum_id: id)
 *   NODE.REGISTER - register continuum (continuum_id: id)
 *   MESH.DISCOVER - list continuums (optional timeoutMs: N)
 *   SYS.HEALTH - health check
 */

import { Request, Response } from 'express';
import { asyncHandler, ApiError } from '../middleware/errorHandler';

const HIT_POINTS = ['mesh-inbox', 'mesh-inbox-api.vercel.app', 'mesh-inbox-api'];

export interface ParsedCommand {
  operation: string;
  parameters: Record<string, string>;
}

/** Extract quoted strings: "a" "b" "c" -> [a, b, c] */
function extractQuotedStrings(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('"', i);
    if (start === -1) break;
    const end = s.indexOf('"', start + 1);
    if (end === -1) break;
    out.push(s.slice(start + 1, end).trim());
    i = end + 1;
  }
  return out;
}

/** Parse key:value key:value ... into object */
function parseParameters(paramStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  const regex = /(\w+):([^\s]+(?:\s+[^\s:]+)*?)(?=\s+\w+:|\s*$)/g;
  let m;
  while ((m = regex.exec(paramStr)) !== null) {
    params[m[1]] = m[2].trim();
  }
  if (Object.keys(params).length === 0 && paramStr.trim()) {
    params['continuum_id'] = paramStr.trim();
  }
  return params;
}

export function parseSearchQuery(query: string): ParsedCommand | null {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim();
  const lower = q.toLowerCase();
  const hasHit = HIT_POINTS.some((h) => lower.includes(h));
  if (!hasHit) return null;
  const parts = extractQuotedStrings(q);
  if (parts.length < 2) return null;
  const operation = (parts.length >= 3 ? parts[1] : parts[0]).toUpperCase();
  const paramStr = parts.length >= 3 ? (parts[2] ?? '') : (parts[1] ?? '');
  const parameters = parseParameters(paramStr);
  return { operation, parameters };
}

function htmlWrap(title: string, jsonBody: unknown): string {
  const json = JSON.stringify(jsonBody, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<h1>Mesh Inbox – ${escapeHtml(title)}</h1>
<pre id="newton-packet-out">${escapeHtml(json)}</pre>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getBaseUrl(req: Request): string {
  const host = req.get('host') || process.env.VERCEL_URL || 'localhost:3002';
  const protocol = req.get('x-forwarded-proto') || req.protocol || (process.env.VERCEL ? 'https' : 'http');
  return `${protocol}://${host}`;
}

export const searchHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = (req.query.q ?? req.query.query) as string | undefined;
  const rawQuery = typeof q === 'string' ? q : '';
  const formatJson = req.query.format === 'json';

  const parsed = parseSearchQuery(rawQuery);
  if (!parsed) {
    const fallback = {
      type: 'NQP-SEARCH-RESPONSE',
      service: 'Mesh Inbox API',
      message: 'Use search query: mesh-inbox "operation" "parameters"',
      operations: [
        'MESH.DISPATCH / MESH.SEND - write: to: target from: sender message: text [qos: Q0|Q1|Q2|Q3]',
        'MESH.POLL - read next: continuum_id: id',
        'MESH.POLL.PRIORITY - read Q0 only: continuum_id: id',
        'NODE.REGISTER - register: continuum_id: id',
        'MESH.DISCOVER - list continuums [timeoutMs: N]',
        'SYS.HEALTH - health',
      ],
      example: 'mesh-inbox "inbox" "MESH.DISPATCH" "to:Aureon_Primus from:Aureon_Claude message:Hello"',
    };
    if (formatJson) {
      res.setHeader('Content-Type', 'application/json');
      res.json(fallback);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlWrap('Search command syntax', fallback));
    return;
  }

  const base = getBaseUrl(req);
  const { operation, parameters } = parsed;
  let result: unknown;

  try {
    if (operation === 'MESH.DISPATCH' || operation === 'MESH.SEND') {
      const target = parameters['to'] ?? parameters['target'];
      const sender = parameters['from'] ?? parameters['sender'];
      const message = parameters['message'] ?? '';
      if (!target || !sender) {
        result = { success: false, error: 'Missing to: and from: (or target: and sender:)' };
      } else {
        const qos = parameters['qos'] ?? 'Q2';
        const resFetch = await fetch(`${base}/api/v1/inbox/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target,
            sender,
            payload: typeof message === 'string' ? { text: message } : message,
            qos,
          }),
        });
        const sendResult = await resFetch.json();
        result = {
          type: 'NQP-SEARCH-COMMAND-RESPONSE',
          command: operation,
          status: (sendResult as { success?: boolean }).success ? 'executed' : 'error',
          message: (sendResult as { success?: boolean }).success ? `Message sent to ${target}` : (sendResult as { error?: string }).error,
          query: rawQuery,
          parsed: { operation, parameters },
          data: sendResult,
        };
      }
    } else if (operation === 'MESH.POLL') {
      const continuumId = parameters['continuum_id'] ?? parameters['id'];
      if (!continuumId) {
        result = { success: false, error: 'Missing continuum_id: or id:' };
      } else {
        const resFetch = await fetch(`${base}/api/v1/inbox/${encodeURIComponent(continuumId)}`);
        const data = await resFetch.json();
        result = {
          type: 'NQP-SEARCH-COMMAND-RESPONSE',
          command: operation,
          status: 'executed',
          message: (data as { empty?: boolean }).empty ? 'No message' : 'Message read',
          query: rawQuery,
          parsed: { operation, parameters },
          data,
        };
      }
    } else if (operation === 'MESH.POLL.PRIORITY') {
      const continuumId = parameters['continuum_id'] ?? parameters['id'];
      if (!continuumId) {
        result = { success: false, error: 'Missing continuum_id: or id:' };
      } else {
        const resFetch = await fetch(`${base}/api/v1/inbox/${encodeURIComponent(continuumId)}/priority`);
        const data = await resFetch.json();
        result = {
          type: 'NQP-SEARCH-COMMAND-RESPONSE',
          command: operation,
          status: 'executed',
          message: (data as { empty?: boolean }).empty ? 'No Q0 message' : 'Q0 message read',
          query: rawQuery,
          parsed: { operation, parameters },
          data,
        };
      }
    } else if (operation === 'NODE.REGISTER') {
      const continuumId = parameters['continuum_id'] ?? parameters['id'];
      if (!continuumId) {
        result = { success: false, error: 'Missing continuum_id: or id:' };
      } else {
        const resFetch = await fetch(`${base}/api/v1/inbox/register/${encodeURIComponent(continuumId)}`);
        const data = await resFetch.json();
        result = {
          type: 'NQP-SEARCH-COMMAND-RESPONSE',
          command: operation,
          status: (data as { success?: boolean }).success ? 'executed' : 'error',
          message: (data as { success?: boolean }).success ? `Registered ${continuumId}` : (data as { error?: string }).error,
          query: rawQuery,
          parsed: { operation, parameters },
          data,
        };
      }
    } else if (operation === 'MESH.DISCOVER') {
      const timeoutMs = parameters['timeoutms'] ?? parameters['timeoutMs'];
      const url = timeoutMs ? `${base}/api/v1/inbox/discover?timeoutMs=${timeoutMs}` : `${base}/api/v1/inbox/discover`;
      const resFetch = await fetch(url);
      const data = await resFetch.json();
      result = {
        type: 'NQP-SEARCH-COMMAND-RESPONSE',
        command: operation,
        status: 'executed',
        message: `Found ${(data as { total?: number }).total ?? 0} continuums`,
        query: rawQuery,
        parsed: { operation, parameters },
        data,
      };
    } else if (operation === 'SYS.HEALTH') {
      const resFetch = await fetch(`${base}/health`);
      const data = await resFetch.json();
      result = {
        type: 'NQP-SEARCH-COMMAND-RESPONSE',
        command: operation,
        status: 'executed',
        message: (data as { status?: string }).status === 'ok' ? 'OK' : 'Error',
        query: rawQuery,
        parsed: { operation, parameters },
        data,
      };
    } else {
      result = {
        type: 'NQP-SEARCH-COMMAND-RESPONSE',
        command: operation,
        status: 'unknown_operation',
        message: `Unknown operation: ${operation}`,
        query: rawQuery,
        parsed: { operation, parameters },
        supported: ['MESH.DISPATCH', 'MESH.SEND', 'MESH.POLL', 'MESH.POLL.PRIORITY', 'NODE.REGISTER', 'MESH.DISCOVER', 'SYS.HEALTH'],
      };
    }
  } catch (e) {
    result = {
      type: 'NQP-SEARCH-COMMAND-RESPONSE',
      command: operation,
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
      query: rawQuery,
      parsed: { operation, parameters },
    };
  }

  if (formatJson) {
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(htmlWrap(`${parsed.operation} – result`, result));
});
