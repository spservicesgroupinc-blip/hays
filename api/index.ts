import type { VercelRequest, VercelResponse } from '@vercel/node';
// Keep the extension here. This function is compiled as native Node ESM by
// Vercel, where an extensionless `../server` import resolves to a nonexistent
// `/var/task/server` file instead of the TypeScript source module.
import app, { normalizeVercelUrl } from '../server.ts';

export { normalizeVercelUrl };

export default function handler(req: VercelRequest, res: VercelResponse) {
  return (app as any)(req, res);
}

