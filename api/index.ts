import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../server';

export function normalizeVercelUrl(req: VercelRequest): void {
  const initialUrl = req.url || '';
  const initialPath = initialUrl.split('?')[0];

  // 1. If req.url is already a concrete sub-path (e.g. /api/auth/register or /auth/register)
  if (initialPath && initialPath !== '/' && initialPath !== '/api' && initialPath !== '/api/') {
    const stripped = initialPath.replace(/^\/api\/?/, '/');
    const queryString = initialUrl.includes('?') ? '?' + initialUrl.split('?')[1] : '';
    req.url = `/api${stripped}${queryString}`;
    return;
  }

  // 2. Check for query path from vercel.json rewrite (e.g. ?path=auth/register) or catch-all ([...all].ts)
  const queryPath = (req.query?.path || req.query?.all || req.query?.route) as string | string[] | undefined;
  if (queryPath) {
    const rawSubpath = Array.isArray(queryPath) ? queryPath.join('/') : String(queryPath);
    const cleanSubpath = rawSubpath.replace(/^\/+/, '').replace(/^api\/?/, '');

    if (cleanSubpath) {
      const originalQueryString = initialUrl.includes('?') ? initialUrl.split('?')[1] : '';
      const searchParams = new URLSearchParams(originalQueryString);
      searchParams.delete('path');
      searchParams.delete('all');
      searchParams.delete('route');
      const remainingQuery = searchParams.toString();

      req.url = `/api/${cleanSubpath}${remainingQuery ? `?${remainingQuery}` : ''}`;
      return;
    }
  }

  // 3. Check for original matched path headers injected by Vercel edge proxy
  const proxyHeader = (req.headers['x-forwarded-uri'] || req.headers['x-original-url'] || req.headers['x-rewrite-url']) as string | undefined;
  if (proxyHeader && typeof proxyHeader === 'string') {
    const headerPath = proxyHeader.split('?')[0];
    if (headerPath !== '/' && headerPath !== '/api' && headerPath !== '/api/') {
      const stripped = headerPath.replace(/^\/api\/?/, '/');
      const queryString = proxyHeader.includes('?') ? '?' + proxyHeader.split('?')[1] : '';
      req.url = `/api${stripped}${queryString}`;
      return;
    }
  }

  // 4. Default: ensure valid root /api route
  if (!req.url || req.url === '/' || req.url === '') {
    req.url = '/api';
  } else if (!req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Set CORS headers for serverless invocations
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MDX, Content-Type, Date, X-Api-Version, Authorization, x-user-id'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // If Vercel already consumed and parsed req.body, mark _body to prevent body-parser stream errors
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' && req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // Keep string if not valid JSON
      }
    }
    (req as any)._body = true;
  }

  normalizeVercelUrl(req);

  return new Promise((resolve) => {
    let finished = false;
    const finishHandler = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    if (typeof (res as any).once === 'function') {
      res.once('finish', finishHandler);
      res.once('close', finishHandler);
      res.once('error', (err: any) => {
        console.error('Vercel response stream error:', err);
        finishHandler();
      });
    } else if (typeof (res as any).on === 'function') {
      (res as any).on('finish', finishHandler);
      (res as any).on('close', finishHandler);
    }

    if (typeof (res as any).end === 'function') {
      const originalEnd = (res as any).end.bind(res);
      (res as any).end = function(...args: any[]) {
        finishHandler();
        return originalEnd(...args);
      };
    }

    try {
      (app as any)(req, res, (err: any) => {
        if (err) {
          console.error('Vercel Express unhandled middleware error:', err);
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: err?.message || 'Internal Server Error'
            });
          }
        } else if (!res.headersSent) {
          res.status(404).json({
            success: false,
            error: `API route not found: ${req.method} ${req.url}`
          });
        }
        finishHandler();
      });
    } catch (topLevelError: any) {
      console.error('Vercel top-level invocation error:', topLevelError);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: topLevelError?.message || 'Server invocation error'
        });
      }
      finishHandler();
    }
  });
}
