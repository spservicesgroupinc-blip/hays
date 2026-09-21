import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../server';

export function normalizeVercelUrl(req: VercelRequest): void {
  // 1. Check for query path from vercel.json rewrite (e.g. ?path=auth/login) or catch-all
  const queryPath = (req.query?.path || req.query?.all || req.query?.route) as string | string[] | undefined;
  if (queryPath) {
    const subpath = Array.isArray(queryPath) ? queryPath.join('/') : queryPath;
    const cleanSubpath = subpath.startsWith('/') ? subpath.slice(1) : subpath;
    
    const originalQueryString = req.url?.includes('?') ? req.url.split('?')[1] : '';
    const searchParams = new URLSearchParams(originalQueryString);
    searchParams.delete('path');
    searchParams.delete('all');
    searchParams.delete('route');
    const remainingQuery = searchParams.toString();

    req.url = `/api/${cleanSubpath}${remainingQuery ? `?${remainingQuery}` : ''}`;
    return;
  }

  // 2. Check for original matched path headers injected by Vercel edge proxy
  const matchedPath = (req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url']) as string | undefined;
  if (matchedPath && typeof matchedPath === 'string' && matchedPath.startsWith('/api')) {
    req.url = matchedPath;
    return;
  }

  // 3. Ensure req.url has /api prefix
  if (req.url && !req.url.startsWith('/api')) {
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

    res.once('finish', finishHandler);
    res.once('close', finishHandler);
    res.once('error', (err: any) => {
      console.error('Vercel response stream error:', err);
      finishHandler();
    });

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
