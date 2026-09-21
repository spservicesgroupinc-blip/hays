import type { VercelRequest, VercelResponse } from '@vercel/node';
import app, { normalizeVercelUrl } from '../server';

export { normalizeVercelUrl };

export default function handler(req: VercelRequest, res: VercelResponse) {
  return (app as any)(req, res);
}

