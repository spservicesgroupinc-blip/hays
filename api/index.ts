import type { VercelRequest, VercelResponse } from '@vercel/node';
// Vercel compiles this sibling TypeScript module to server.js. Using its
// emitted ESM filename avoids Node attempting to resolve /var/task/server.
import app, { normalizeVercelUrl } from './server.js';

export { normalizeVercelUrl };

export default function handler(req: VercelRequest, res: VercelResponse) {
  return (app as any)(req, res);
}

