import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../server';

export function normalizeVercelUrl(req: VercelRequest): void {
  // 1. Check for original matched path headers injected by Vercel edge proxy
  const matchedPath = (req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url']) as string | undefined;
  if (matchedPath && typeof matchedPath === 'string' && matchedPath.startsWith('/api')) {
    req.url = matchedPath;
    return;
  }

  // 2. Check for catch-all query parameter (from [...all].ts or rewrites)
  if (req.query?.all) {
    const subpath = Array.isArray(req.query.all) ? req.query.all.join('/') : req.query.all;
    req.url = `/api/${subpath}`;
    return;
  }

  // 3. Ensure req.url has /api prefix
  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  normalizeVercelUrl(req);
  return app(req as any, res as any);
}
