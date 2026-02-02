/**
 * Substrate requirement (non-negotiable): GPT and some clients require valid HTML5,
 * not JSON-only. Use Accept: text/html or ?format=html to get HTML with embedded JSON.
 */

import { Request, Response } from 'express';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function htmlWrap(title: string, data: unknown): string {
  const json = JSON.stringify(data, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<h1>Mesh Inbox – ${escapeHtml(title)}</h1>
<pre id="newton-packet-out">${escapeHtml(json)}</pre>
</body>
</html>`;
}

export function wantsHtml(req: Request): boolean {
  const format = req.query.format as string | undefined;
  if (format === 'html') return true;
  const accept = req.get('Accept') || '';
  return accept.toLowerCase().includes('text/html');
}

export function sendJsonOrHtml(req: Request, res: Response, title: string, data: unknown): void {
  if (wantsHtml(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlWrap(title, data));
  } else {
    res.json(data);
  }
}
