import type { VercelRequest, VercelResponse } from '@vercel/node';
// Vercel executes the compiled ESM output, where the sibling entrypoint is
// index.js rather than an extensionless path.
import handler from './index.js';

export default handler;
