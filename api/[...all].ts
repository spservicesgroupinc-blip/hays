import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../server';
import { normalizeVercelUrl } from './index';

export default function handler(req: VercelRequest, res: VercelResponse) {
  normalizeVercelUrl(req);
  return app(req as any, res as any);
}
