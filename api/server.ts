import express from 'express';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { extractEstimate, normalizeDocumentText, nextSequentialId, sanitizeFieldScope, buildFieldInstruction, GENERAL_TRADE, type EstimateExtraction, type FieldWorkOrderSection } from './estimate-extractor.js';

const app = express();
const PORT = 3000;
const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
  process.env.VERCEL_ENV ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

// Handle serverless pre-parsed bodies (e.g. Vercel @vercel/node) so body-parser does not crash on consumed stream
app.use((req, _res, next) => {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' && req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // Leave as string if not valid JSON
      }
    }
    (req as any)._body = true;
  }
  next();
});

// Body parser for base64 camera image uploads and PDF estimate files
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// CORS & Preflight support for Vercel preview branches and custom domains.
// Restrict to a known-origin allowlist instead of '*'; same-origin requests
// (the SPA and API are served together) need no CORS header at all.
function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return false;
  const allowlist: (string | RegExp)[] = [];
  if (process.env.APP_URL) allowlist.push(process.env.APP_URL.replace(/\/$/, ''));
  if (process.env.VERCEL_URL) allowlist.push(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_BRANCH_URL) allowlist.push(`https://${process.env.VERCEL_BRANCH_URL}`);
  // Vercel auto-assigns *.vercel.app preview URLs; allow Hays + Sons custom domains.
  allowlist.push(/^https:\/\/[\w-]+\.vercel\.app$/i);
  allowlist.push(/^https:\/\/[\w.-]*haysandsons\.com$/i);
  return allowlist.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
  );
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && typeof origin === 'string' && isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// URL normalization for serverless environments (handles Vercel rewrites & stripped /api prefixes)
export function normalizeVercelUrl(req: any): void {
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
  const queryPath = (req.query?.path || req.query?.all || req.query?.route);
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

  // 3. Check proxy headers (x-forwarded-uri, x-original-url, x-rewrite-url)
  const proxyHeader = (req.headers?.['x-forwarded-uri'] || req.headers?.['x-original-url'] || req.headers?.['x-rewrite-url']);
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

app.use((req, _res, next) => {
  try {
    normalizeVercelUrl(req);
  } catch (e) {
    console.warn('URL normalization notice:', e);
  }
  next();
});

// ----------------------------------------------------------------------------
// DATA MODELS & TYPES
// ----------------------------------------------------------------------------
interface LineItem {
  lineId: string;
  woId: string;
  taskDescription: string;
  /** Plain-English field instruction for this scope line (verb-first, no pricing). */
  instruction?: string;
  status: 'Pending' | 'Completed' | 'Flagged';
  photoUrl: string;
  notes?: string;
  timestamp: string;
}

interface JobRecord {
  id: string;
  customerName: string;
  propertyAddress: string;
  phone?: string;
  email?: string;
  claimNumber?: string;
  lossType?: string;
  totalEstimate?: string;
  notes?: string;
  scopeSummary?: string;
  extractedTrades?: { tradeName: string; tasks: string[] }[];
  extractedTasks?: string[];
  /** Trade-by-trade field package produced by the extraction pipeline. */
  fieldPackage?: FieldWorkOrderSection[];
  createdAt: string;
  workOrderIds: string[];
  /** Extraction provenance - lets the PM see how the scope was produced. */
  sourceHash?: string;
  extractionMethod?: string;
  extractionConfidence?: number;
  extractionWarnings?: string[];
  documentStats?: { characters: number; pages: number; hasTextLayer: boolean; lookedLikeScan: boolean };
}

interface WorkOrder {
  woId: string;
  jobId?: string;
  projectName: string;
  customerName?: string;
  propertyAddress?: string;
  trade?: string;
  unitArea: string;
  subName: string;
  subPhone: string;
  assignedSubId?: string;
  scheduledDate: string;
  status: 'Open' | 'In Progress' | 'Completed';
  totalItems: number;
  completedItems: number;
  signedBy?: string;
  signedAt?: string;
  createdBy?: string;
  /** Hash of the exact task scope so the same scope can never be dispatched twice. */
  scopeHash?: string;
  sourceJobId?: string;
  /** Field-ready instructions for this trade (safety, materials, QC, exclusions). */
  fieldPackage?: FieldWorkOrderSection[];
}

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: 'pm' | 'subcontractor';
  company: string;
  trade?: string;
  phone?: string;
  assignedWoIds: string[];
  permissions: string[];
  salt: string;
  passwordHash: string;
  createdAt?: string;
  tempPassword?: string;
  password?: string;
}

interface ActivityEvent {
  id: string;
  timestamp: string;
  type: 'photo_uploaded' | 'ai_verified' | 'wo_created' | 'wo_completed' | 'sub_created' | 'pm_created' | 'sub_signed_off';
  subId?: string;
  subName: string;
  company: string;
  woId?: string;
  projectName?: string;
  lineId?: string;
  taskDescription?: string;
  verdict?: 'PASS' | 'RETAKE_NEEDED' | '';
  notes?: string;
  photoUrl?: string;
}

interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: number;
}

// ----------------------------------------------------------------------------
// CRYPTOGRAPHY & SECURITY HELPERS
// ----------------------------------------------------------------------------
function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  return hashPassword(password, salt) === hash;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Resolve a stable signing secret for authentication tokens. The previous
// behavior generated a new random secret on every process start, which made
// every token issued by a previous process (or a different serverless
// instance) fail verification with "Authentication required".
function resolveAuthSecret(): string {
  const configured = (process.env.AUTH_SECRET || '').trim();
  if (configured) return configured;

  // On serverless deployments, derive a deterministic secret from the stable
  // deployment URL so every cold-start instance shares the same signing key.
  const deploymentId = (
    process.env.APP_URL ||
    process.env.VERCEL_BRANCH_URL ||
    process.env.VERCEL_URL ||
    ''
  ).trim();
  if (deploymentId) {
    return crypto.createHash('sha256')
      .update(`fieldproof:auth-secret:${deploymentId}`)
      .digest('hex');
  }

  // Local development: persist a generated secret so sessions survive
  // server restarts.
  try {
    const secretDir = getWritableDataDir();
    const secretFile = path.join(secretDir, 'auth_secret.txt');
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf-8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(secretFile, generated, 'utf-8');
    console.warn('[WARNING] AUTH_SECRET environment variable is not set. Generated a persistent local secret; set AUTH_SECRET for production stability.');
    return generated;
  } catch (err: any) {
    console.warn('[WARNING] AUTH_SECRET environment variable is not set and a persistent secret could not be stored. Sessions may not survive restarts.');
    return crypto.randomBytes(32).toString('hex');
  }
}

const AUTH_SECRET = resolveAuthSecret();

interface TokenPayload {
  uid: string;
  email: string;
  role: 'pm' | 'subcontractor';
  name?: string;
  company?: string;
  exp: number;
}

function generateSecureToken(user?: { id: string; email: string; role: 'pm' | 'subcontractor'; name?: string; company?: string }): string {
  if (!user) {
    return crypto.randomBytes(32).toString('hex');
  }
  const payload: TokenPayload = {
    uid: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    company: user.company,
    exp: Date.now() + SEVEN_DAYS_MS
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  const token = `${data}.${sig}`;
  sessionsDb[token] = {
    token,
    userId: user.id,
    expiresAt: payload.exp
  };
  return token;
}

function verifyAndDecodeToken(token: string): TokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
    if (sig !== expectedSig) return null;
    const payload: TokenPayload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    if (!payload || !payload.uid || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// USER & SESSION DATABASE (ZERO MOCK DATA - STARTS CLEAN FROM SCRATCH)
// ----------------------------------------------------------------------------
const usersDb: Record<string, UserRecord> = {};
const sessionsDb: Record<string, SessionRecord> = {};

// ----------------------------------------------------------------------------
// REAL-TIME ACTIVITY LOG (STARTS CLEAN)
// ----------------------------------------------------------------------------
const activityLogsDb: ActivityEvent[] = [];

function getSafeUser(user: UserRecord, token?: string) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    company: user.company,
    trade: user.trade || (user.role === 'pm' ? 'Project Management' : 'Trade Subcontractor'),
    phone: user.phone,
    assignedWoIds: user.assignedWoIds,
    permissions: user.permissions,
    createdAt: user.createdAt,
    tempPassword: user.tempPassword,
    token
  };
}

function getUserFromRequest(req: express.Request): UserRecord | null {
  const authHeader = req.headers.authorization;
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  // 1. If we have a signed stateless token, verify it (works across all serverless lambda instances)
  if (token) {
    const payload = verifyAndDecodeToken(token);
    if (payload) {
      let user = usersDb[payload.uid] || Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === payload.email.toLowerCase().trim());
      if (user) return user;

      // Try reading local storage in case this instance hasn't loaded state
      loadDatabaseState();
      user = usersDb[payload.uid] || Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === payload.email.toLowerCase().trim());
      if (user) return user;

      // Reconstruct valid authorized user from verified stateless token
      const permissions = payload.role === 'pm'
        ? ['create_work_order', 'view_all_work_orders', 'edit_work_order', 'delete_work_order', 'view_analytics']
        : ['view_assigned_work_orders', 'upload_inspection_photo', 'sign_off_work_order'];

      const reconstructedUser: UserRecord = {
        id: payload.uid,
        email: payload.email,
        name: payload.name || (payload.role === 'pm' ? 'Project Manager' : 'Subcontractor Partner'),
        role: payload.role,
        company: payload.company || (payload.role === 'pm' ? 'Hays + Sons Restoration' : 'Trade Partner'),
        trade: payload.role === 'pm' ? 'General Restoration & Project Management' : 'Trade Subcontractor',
        assignedWoIds: [],
        permissions,
        salt: 'stateless',
        passwordHash: 'stateless',
        createdAt: new Date().toISOString()
      };
      usersDb[payload.uid] = reconstructedUser;
      return reconstructedUser;
    }

    // Direct active session cache check
    if (sessionsDb[token] && sessionsDb[token].expiresAt >= Date.now()) {
      const sessionUser = usersDb[sessionsDb[token].userId];
      if (sessionUser) return sessionUser;
    }

    // Direct user ID token check
    if (usersDb[token]) {
      return usersDb[token];
    }
  }

  // No unauthenticated fallback: callers must present a valid Bearer token.
  // (The previous 'x-user-id' header trust allowed cross-origin impersonation
  // of any user by supplying a guessable ID.)
  return null;
}

function canUserAccessWorkOrder(user: UserRecord, woId: string, wo?: WorkOrder): boolean {
  if (user.role === 'pm') return true;
  if (!wo) return false;

  const upperWoId = woId.toUpperCase();
  if (user.assignedWoIds.map(id => id.toUpperCase()).includes(upperWoId)) {
    return true;
  }
  if (wo.assignedSubId && wo.assignedSubId === user.id) {
    return true;
  }
  if (user.phone && wo.subPhone && user.phone.replace(/\D/g, '') === wo.subPhone.replace(/\D/g, '')) {
    return true;
  }
  if (user.company && wo.subName && user.company.toLowerCase().trim() === wo.subName.toLowerCase().trim()) {
    return true;
  }

  return false;
}

// ----------------------------------------------------------------------------
// JOBS, WORK ORDERS & SUBCONTRACTORS DATABASE
// ----------------------------------------------------------------------------
const jobsDb: Record<string, JobRecord> = {};
const workOrdersDb: Record<string, WorkOrder> = {};
const lineItemsDb: Record<string, LineItem[]> = {};

// ----------------------------------------------------------------------------
// PERSISTENT DISK STORAGE & CACHING
// ----------------------------------------------------------------------------
function getWritableDataDir(): string {
  if (isServerlessRuntime) {
    return path.join('/tmp', 'data');
  }
  const localDir = path.join(process.cwd(), 'data');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.accessSync(localDir, fs.constants.W_OK);
    return localDir;
  } catch {
    return path.join('/tmp', 'data');
  }
}

const DATA_DIR = getWritableDataDir();
const DATA_FILE = path.join(DATA_DIR, 'app_database.json');

let customAppsScriptUrl: string = process.env.APPS_SCRIPT_URL || '';

function getEffectiveAppsScriptUrl(): string {
  return customAppsScriptUrl.trim() || process.env.APPS_SCRIPT_URL || '';
}

function saveDatabaseState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const payload = {
      version: 2,
      savedAt: new Date().toISOString(),
      customAppsScriptUrl,
      users: usersDb,
      workOrders: workOrdersDb,
      lineItems: lineItemsDb,
      jobs: jobsDb,
      activityLogs: activityLogsDb.slice(0, 250)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('Persistence save notice:', err.message);
  }
}

function loadDatabaseState() {
  try {
    let sourceFile = DATA_FILE;
    const defaultStaticDb = path.join(process.cwd(), 'data', 'app_database.json');
    if (!fs.existsSync(sourceFile) && fs.existsSync(defaultStaticDb)) {
      sourceFile = defaultStaticDb;
    }
    if (fs.existsSync(sourceFile)) {
      const raw = fs.readFileSync(sourceFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data.users && typeof data.users === 'object') {
        Object.assign(usersDb, data.users);
      }
      if (data.workOrders && typeof data.workOrders === 'object') {
        Object.assign(workOrdersDb, data.workOrders);
      }
      if (data.lineItems && typeof data.lineItems === 'object') {
        Object.assign(lineItemsDb, data.lineItems);
      }
      if (data.jobs && typeof data.jobs === 'object') {
        Object.assign(jobsDb, data.jobs);
      }
      if (Array.isArray(data.activityLogs) && data.activityLogs.length > 0) {
        activityLogsDb.length = 0;
        activityLogsDb.push(...data.activityLogs);
      }
      if (data.customAppsScriptUrl) {
        customAppsScriptUrl = data.customAppsScriptUrl;
      }
      console.log(`Loaded persisted state: ${Object.keys(usersDb).length} users, ${Object.keys(workOrdersDb).length} work orders.`);
    }
  } catch (err: any) {
    console.warn('Persistence load notice:', err.message);
  }
}

// ----------------------------------------------------------------------------
// GOOGLE APPS SCRIPT CLOUD SYNC (STORED AS A SECURE SERVER-SIDE SECRET)
// ----------------------------------------------------------------------------
async function callAppsScript(action: string, payload: Record<string, any>, timeoutMs = 5000): Promise<any> {
  const url = getEffectiveAppsScriptUrl();
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`Apps Script '${action}' returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err: any) {
    clearTimeout(timer);
    console.warn(`Apps Script sync error for action '${action}':`, err.message);
    return null;
  }
}

// Hydrate server in-memory cache directly from Google Sheets (source of truth)
async function syncFromGoogleSheets(): Promise<{ workOrdersCount: number; subcontractorsCount: number; projectManagersCount: number }> {
  try {
    const data = await callAppsScript('fetchDatabaseState', {});
    if (data && data.success) {
      // 1. Sync durable jobs before attaching their work orders.
      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          const id = String(job.id || '').trim();
          if (!id) continue;
          jobsDb[id] = {
            id,
            customerName: String(job.customerName || ''),
            propertyAddress: String(job.propertyAddress || ''),
            phone: String(job.phone || ''),
            email: String(job.email || ''),
            claimNumber: String(job.claimNumber || ''),
            lossType: String(job.lossType || 'Restoration'),
            totalEstimate: String(job.totalEstimate || ''),
            notes: String(job.notes || ''),
            scopeSummary: String(job.scopeSummary || ''),
            extractedTasks: Array.isArray(job.extractedTasks) ? job.extractedTasks : [],
            extractedTrades: Array.isArray(job.extractedTrades) ? job.extractedTrades : [],
            createdAt: String(job.createdAt || new Date().toISOString()),
            workOrderIds: []
          };
        }
      }

      // 2. Sync Work Orders
      if (Array.isArray(data.workOrders)) {
        for (const wo of data.workOrders) {
          const upperWoId = String(wo.woId).trim().toUpperCase();
          if (!upperWoId) continue;
          
          workOrdersDb[upperWoId] = {
            woId: upperWoId,
            jobId: wo.jobId || undefined,
            projectName: wo.projectName || `Work Order ${upperWoId}`,
            customerName: (wo.jobId && jobsDb[wo.jobId] ? jobsDb[wo.jobId].customerName : '') || (wo.projectName ? wo.projectName.split(' - ')[0] : ''),
            propertyAddress: (wo.jobId && jobsDb[wo.jobId] ? jobsDb[wo.jobId].propertyAddress : '') || wo.propertyAddress || '',
            trade: wo.trade || GENERAL_TRADE,
            unitArea: wo.unitArea || 'Restoration Scope',
            subName: wo.subName || '',
            subPhone: wo.subPhone || '',
            assignedSubId: wo.assignedSubId || '',
            scheduledDate: wo.scheduledDate || '',
            status: wo.status || 'Open',
            totalItems: Number(wo.totalItems || 0),
            completedItems: Number(wo.completedItems || 0),
            signedBy: wo.signedBy || undefined,
            signedAt: wo.signedAt || undefined,
            createdBy: wo.createdBy || 'Project Manager',
            scopeHash: wo.scopeHash || undefined
          };
          if (wo.jobId && jobsDb[wo.jobId] && !jobsDb[wo.jobId].workOrderIds.includes(upperWoId)) {
            jobsDb[wo.jobId].workOrderIds.push(upperWoId);
          }
        }
      }

      // 3. Sync Line Items
      if (data.lineItems && typeof data.lineItems === 'object') {
        for (const [woId, items] of Object.entries(data.lineItems)) {
          const upperWoId = String(woId).trim().toUpperCase();
          if (Array.isArray(items)) {
            lineItemsDb[upperWoId] = items as LineItem[];
          }
        }
      }

      // 4. Sync Subcontractors from Sheets if present
      if (Array.isArray(data.subcontractors)) {
        for (const sub of data.subcontractors) {
          if (!sub.email) continue;
          const cleanEmail = String(sub.email).trim().toLowerCase();
          const existing = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
          const subPass = String(sub.password || '').trim();
          
          if (!existing) {
            const subId = sub.id || `usr_sub_${Date.now().toString(36)}`;
            const salt = `salt_sub_${Date.now()}`;
            const effectivePass = subPass || crypto.randomBytes(12).toString('base64url');
            usersDb[subId] = {
              id: subId,
              email: cleanEmail,
              name: sub.name || sub.company || 'Subcontractor Crew',
              role: 'subcontractor',
              company: sub.company || 'Trade Partner LLC',
              trade: sub.trade || 'General Restoration',
              phone: sub.phone || '',
              assignedWoIds: [],
              permissions: ['view_assigned_work_orders', 'upload_inspection_photo', 'sign_off_work_order'],
              salt,
              passwordHash: hashPassword(effectivePass, salt),
              tempPassword: effectivePass,
              password: effectivePass,
              createdAt: new Date().toISOString()
            };
          } else {
            // Update details without clobbering existing custom password
            if (sub.company) existing.company = sub.company;
            if (sub.name) existing.name = sub.name;
            if (sub.trade) existing.trade = sub.trade;
            if (sub.phone) existing.phone = sub.phone;
            if (subPass) {
              existing.salt = `salt_sub_${Date.now()}`;
              existing.passwordHash = hashPassword(subPass, existing.salt);
              existing.tempPassword = subPass;
              existing.password = subPass;
            }
          }
        }
      }

      // 5. Sync Project Managers from Sheets if present
      if (Array.isArray(data.projectManagers)) {
        for (const pm of data.projectManagers) {
          if (!pm.email) continue;
          const cleanEmail = String(pm.email).trim().toLowerCase();
          const existing = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
          const pmPass = String(pm.password || '').trim();
          
          if (!existing) {
            const pmId = pm.id || `usr_pm_${Date.now().toString(36)}`;
            const salt = `salt_pm_${Date.now()}`;
            const effectivePass = pmPass || crypto.randomBytes(12).toString('base64url');
            usersDb[pmId] = {
              id: pmId,
              email: cleanEmail,
              name: pm.name || 'Project Manager',
              role: 'pm',
              company: pm.company || 'Hays + Sons Restoration',
              trade: 'General Restoration & Project Management',
              phone: pm.phone || '',
              assignedWoIds: [],
              permissions: [
                'create_work_order',
                'view_all_work_orders',
                'edit_work_order',
                'delete_work_order',
                'view_analytics'
              ],
              salt,
              passwordHash: hashPassword(effectivePass, salt),
              tempPassword: effectivePass,
              password: effectivePass,
              createdAt: new Date().toISOString()
            };
          } else {
            // Update details without clobbering existing custom password
            if (pm.name) existing.name = pm.name;
            if (pm.company) existing.company = pm.company;
            if (pm.phone) existing.phone = pm.phone;
            if (pmPass) {
              existing.salt = `salt_pm_${Date.now()}`;
              existing.passwordHash = hashPassword(pmPass, existing.salt);
              existing.tempPassword = pmPass;
              existing.password = pmPass;
            }
          }
        }
      }

      saveDatabaseState();
      console.log(`Synced ${Object.keys(workOrdersDb).length} work orders, ${Object.values(usersDb).filter(u => u.role === 'subcontractor').length} subcontractors from Google Sheets.`);
    }
  } catch (err: any) {
    console.log('Google Sheets initial sync notice:', err.message);
  }
  return {
    workOrdersCount: Object.keys(workOrdersDb).length,
    subcontractorsCount: Object.values(usersDb).filter(u => u.role === 'subcontractor').length,
    projectManagersCount: Object.values(usersDb).filter(u => u.role === 'pm').length
  };
}

// 1. Load state from persistent local disk
loadDatabaseState();

// 2. Sync from Google Sheets in background (only in persistent servers, never unhandled in serverless init)
if (!isServerlessRuntime) {
  syncFromGoogleSheets().catch(err => {
    console.warn('Initial background sync notice:', err?.message);
  });
}

// Vercel instances have no durable process memory. Hydrate the first request
// on each instance from the configured Google Sheets source of truth so jobs,
// subcontractor assignments, and punch-list tasks remain available after a
// cold start or instance switch.
let serverlessHydration: Promise<unknown> | null = null;
app.use(async (_req, _res, next) => {
  if (!isServerlessRuntime) {
    next();
    return;
  }
  try {
    if (!serverlessHydration) {
      serverlessHydration = syncFromGoogleSheets();
    }
    await serverlessHydration;
  } catch (err: any) {
    console.warn('Serverless Google Sheets hydration notice:', err?.message);
  }
  next();
});

// ----------------------------------------------------------------------------
// API ROUTES
// ----------------------------------------------------------------------------

// 1. Health check & Sync
app.get('/api', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Hays + Sons FieldProof API',
    serverTime: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    serverTime: new Date().toISOString()
  });
});

app.get('/api/auth/status', (req, res) => {
  const pms = Object.values(usersDb).filter(u => u.role === 'pm');
  const subs = Object.values(usersDb).filter(u => u.role === 'subcontractor');
  res.json({
    success: true,
    hasProjectManager: pms.length > 0,
    pmCount: pms.length,
    subcontractorCount: subs.length
  });
});

app.post('/api/sync/refresh', async (req, res) => {
  const result = await syncFromGoogleSheets();
  res.json({
    success: true,
    message: 'Synchronized with Google Sheets.',
    ...result
  });
});

// 2. Authentication: Create Project Manager Account (Setup)
app.post('/api/auth/register-pm', async (req, res) => {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* ignore */ }
    }
    const { name, email, company, phone, password } = body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Full Name, Email Address, and Password are required.' });
    }

    const cleanEmail = String(email || '').trim().toLowerCase();
    const existing = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: `An account with email ${cleanEmail} already exists. Please sign in instead.` });
    }

    const pmId = `usr_pm_${Date.now().toString(36)}`;
    const pmSalt = `salt_pm_${Date.now()}`;
    const passwordHash = hashPassword(password, pmSalt);

    const newPm: UserRecord = {
      id: pmId,
      email: cleanEmail,
      name: name.trim(),
      role: 'pm',
      company: company?.trim() || 'Hays + Sons Restoration',
      trade: 'General Restoration & Project Management',
      phone: phone?.trim() || '',
      assignedWoIds: [],
      permissions: [
        'create_work_order',
        'view_all_work_orders',
        'edit_work_order',
        'delete_work_order',
        'view_analytics'
      ],
      salt: pmSalt,
      passwordHash,
      tempPassword: password,
      password,
      createdAt: new Date().toISOString()
    };

    usersDb[pmId] = newPm;
    saveDatabaseState();

    const token = generateSecureToken(newPm);
    sessionsDb[token] = {
      token,
      userId: pmId,
      expiresAt: Date.now() + SEVEN_DAYS_MS
    };

    // Log Activity
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    activityLogsDb.unshift({
      id: `act_${Date.now()}`,
      timestamp: nowTime,
      type: 'pm_created',
      subId: pmId,
      subName: newPm.name,
      company: newPm.company,
      taskDescription: `Project Manager account established: ${newPm.name}`,
      notes: `Registered as administrator`
    });

    // Synchronize to Google Sheets ProjectManagers tab with password
    callAppsScript('registerPM', {
      name: newPm.name,
      email: newPm.email,
      company: newPm.company,
      phone: newPm.phone,
      password
    }, 3000).catch(e => console.error('Cloud sheet PM creation sync notice:', e.message));

    res.json({
      success: true,
      message: 'Project Manager account created successfully.',
      token,
      user: getSafeUser(newPm, token)
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Authentication: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* ignore */ }
    }
    const { email, password } = body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const trimmedPass = String(password).trim();

    let user = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);

    if (!user) {
      loadDatabaseState();
      user = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
    }

    let isPasswordValid = false;
    if (user) {
      if (verifyPassword(trimmedPass, user.salt, user.passwordHash)) {
        isPasswordValid = true;
      } else if (user.tempPassword && user.tempPassword === trimmedPass) {
        isPasswordValid = true;
      } else if (user.password && user.password === trimmedPass) {
        isPasswordValid = true;
      }
    }

    // If credentials not valid or user not found locally, query Apps Script (Google Sheets)
    if (!user || !isPasswordValid) {
      try {
        const gasAuth = await callAppsScript('authenticateUser', { email: cleanEmail, password: trimmedPass });
        if (gasAuth && gasAuth.success && gasAuth.user) {
          const u = gasAuth.user;
          const role = (u.role === 'pm' ? 'pm' : 'subcontractor');
          const userId = u.id || `usr_${role}_${Date.now().toString(36)}`;
          const salt = `salt_${Date.now()}`;

          user = {
            id: userId,
            email: cleanEmail,
            name: u.name || (role === 'pm' ? 'Project Manager' : 'Subcontractor Crew'),
            role,
            company: u.company || (role === 'pm' ? 'Hays + Sons Restoration' : 'Trade Partner'),
            trade: u.trade || (role === 'pm' ? 'General Restoration & Project Management' : 'General Restoration'),
            phone: u.phone || '',
            assignedWoIds: [],
            permissions: role === 'pm'
              ? ['create_work_order', 'view_all_work_orders', 'edit_work_order', 'delete_work_order', 'view_analytics']
              : ['view_assigned_work_orders', 'upload_inspection_photo', 'sign_off_work_order'],
            salt,
            passwordHash: hashPassword(trimmedPass, salt),
            tempPassword: trimmedPass,
            password: trimmedPass,
            createdAt: new Date().toISOString()
          };
          usersDb[userId] = user;
          saveDatabaseState();
          isPasswordValid = true;
        }
      } catch (gasErr: any) {
        console.warn('Apps Script authentication query notice:', gasErr.message);
      }
    }

    if (!user || !isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password. Please verify your credentials or register your account.' 
      });
    }

    const token = generateSecureToken(user);
    sessionsDb[token] = {
      token,
      userId: user.id,
      expiresAt: Date.now() + SEVEN_DAYS_MS
    };

    res.json({
      success: true,
      token,
      user: getSafeUser(user, token)
    });
  } catch (err: any) {
    console.error('Login route error:', err);
    res.status(500).json({ success: false, error: err.message || 'Login error occurred.' });
  }
});

// 3. Authentication: Register
app.post('/api/auth/register', async (req, res) => {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ success: false, error: 'Invalid JSON request payload.' });
      }
    }

    const { email, password, name, role, company, phone, trade } = body;
    const cleanEmail = String(email || '').toLowerCase().trim();
    const strPass = String(password || '').trim();
    const strName = String(name || '').trim();
    const targetRole = String(role || '').trim().toLowerCase();

    if (!cleanEmail || !strPass || !strName || !targetRole) {
      return res.status(400).json({ success: false, error: 'Full name, email address, password, and role are required.' });
    }

    if (targetRole !== 'pm' && targetRole !== 'subcontractor') {
      return res.status(400).json({ success: false, error: 'Role must be either "pm" or "subcontractor".' });
    }

    if (strPass.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    const existing = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
    if (existing) {
      return res.status(400).json({ success: false, error: 'An account with this email address already exists. Please sign in instead.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(strPass, salt);
    const id = `usr_${targetRole}_${Date.now()}`;

    const permissions = targetRole === 'pm'
      ? ['create_work_order', 'view_all_work_orders', 'edit_work_order', 'delete_work_order', 'view_analytics']
      : ['view_assigned_work_orders', 'upload_inspection_photo', 'sign_off_work_order'];

    const resolvedTrade = trade && typeof trade === 'string' && trade.trim() 
      ? trade.trim() 
      : (targetRole === 'pm' ? 'General Restoration & Project Management' : 'Trade Subcontractor');

    const newUser: UserRecord = {
      id,
      email: cleanEmail,
      name: strName,
      role: targetRole as 'pm' | 'subcontractor',
      company: company && typeof company === 'string' && company.trim() 
        ? company.trim() 
        : (targetRole === 'pm' ? 'Hays + Sons Restoration' : 'Trade Partner'),
      trade: resolvedTrade,
      phone: phone && typeof phone === 'string' ? phone.trim() : '',
      assignedWoIds: [],
      permissions,
      salt,
      passwordHash,
      tempPassword: strPass,
      password: strPass,
      createdAt: new Date().toISOString()
    };

    usersDb[id] = newUser;
    saveDatabaseState();

    let nowTime = '';
    try {
      nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      nowTime = new Date().toISOString().substring(11, 16);
    }

    if (targetRole === 'subcontractor') {
      activityLogsDb.unshift({
        id: `act_${Date.now()}`,
        timestamp: nowTime,
        type: 'sub_created',
        subId: id,
        subName: newUser.name,
        company: newUser.company,
        taskDescription: `Subcontractor account created (${resolvedTrade})`,
        notes: `Registered via portal`
      });

      // Synchronize new subcontractor directly to Google Sheet
      try {
        await callAppsScript('registerSubcontractor', {
          company: newUser.company,
          name: newUser.name,
          trade: newUser.trade,
          email: newUser.email,
          phone: newUser.phone,
          password: strPass
        }, 3000);
      } catch (e: any) {
        console.warn('Cloud sheet registration sync notice:', e?.message);
      }
    } else if (targetRole === 'pm') {
      activityLogsDb.unshift({
        id: `act_${Date.now()}`,
        timestamp: nowTime,
        type: 'pm_created',
        subId: id,
        subName: newUser.name,
        company: newUser.company,
        taskDescription: `Project Manager account created: ${newUser.name}`,
        notes: `Registered via portal`
      });

      // Synchronize new PM directly to Google Sheet
      try {
        await callAppsScript('registerPM', {
          name: newUser.name,
          email: newUser.email,
          company: newUser.company,
          phone: newUser.phone,
          password: strPass
        }, 3000);
      } catch (e: any) {
        console.warn('Cloud sheet PM registration sync notice:', e?.message);
      }
    }

    const token = generateSecureToken(newUser);
    sessionsDb[token] = {
      token,
      userId: id,
      expiresAt: Date.now() + SEVEN_DAYS_MS
    };

    return res.status(201).json({
      success: true,
      token,
      user: getSafeUser(newUser, token)
    });
  } catch (err: any) {
    console.error('Registration error:', err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'An unexpected error occurred while creating your account.'
    });
  }
});

// 4. Authentication: Current Profile
app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7).trim() : undefined;
  res.json({ success: true, user: getSafeUser(user, token) });
});

// 5. Authentication: Logout
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    delete sessionsDb[token];
  }
  res.json({ success: true });
});

// 5b. Jobs: Get all jobs (with associated work orders)
app.get('/api/jobs', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const jobsList = Object.values(jobsDb).map(job => {
    let wos = job.workOrderIds.map(id => workOrdersDb[id]).filter(Boolean);
    // If subcontractor, only show work orders assigned to them
    if (user.role === 'subcontractor') {
      wos = wos.filter(wo => canUserAccessWorkOrder(user, wo.woId, wo));
    }
    return {
      ...job,
      workOrders: wos
    };
  });

  // Filter out jobs with 0 work orders for subcontractors if they have no assignments
  const visibleJobs = user.role === 'pm' 
    ? jobsList 
    : jobsList.filter(j => (j.workOrders && j.workOrders.length > 0));

  res.json({ success: true, jobs: visibleJobs });
});

// 5c. Jobs: Get specific job by ID
app.get('/api/jobs/:id', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const { id } = req.params;
  const job = jobsDb[id];
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  let wos = job.workOrderIds.map(woId => workOrdersDb[woId]).filter(Boolean);
  if (user.role === 'subcontractor') {
    wos = wos.filter(wo => canUserAccessWorkOrder(user, wo.woId, wo));
  }

  res.json({
    success: true,
    job: {
      ...job,
      workOrders: wos
    }
  });
});

// 5d. Jobs: Create new Job (PM only)
app.post('/api/jobs', async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user || user.role !== 'pm') {
    return res.status(403).json({ success: false, error: 'Only Project Managers can create jobs' });
  }

  const { customerName, propertyAddress, phone, email, claimNumber, lossType, totalEstimate, notes, extractedTasks, extractedTrades } = req.body;
  if (!customerName || !propertyAddress) {
    return res.status(400).json({ success: false, error: 'Customer name and property address are required' });
  }

  const id = allocateJobId();
  const newJob: JobRecord = {
    id,
    customerName: customerName.trim(),
    propertyAddress: propertyAddress.trim(),
    phone: phone ? phone.trim() : '',
    email: email ? email.trim() : '',
    claimNumber: claimNumber ? claimNumber.trim() : `CLM-${Math.floor(100000 + Math.random() * 900000)}`,
    lossType: lossType ? lossType.trim() : 'Restoration',
    totalEstimate: totalEstimate ? totalEstimate.trim() : '',
    notes: notes ? notes.trim() : '',
    scopeSummary: propertyAddress,
    extractedTasks: Array.isArray(extractedTasks) ? extractedTasks : [],
    extractedTrades: Array.isArray(extractedTrades) ? extractedTrades : [],
    createdAt: new Date().toISOString(),
    workOrderIds: []
  };

  jobsDb[id] = newJob;
  saveDatabaseState();

  try {
    await callAppsScript('createJob', { job: newJob });
  } catch (gasErr: any) {
    console.warn('Apps Script createJob sync notice:', gasErr.message);
  }

  activityLogsDb.unshift({
    id: `act_${Date.now()}`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    type: 'wo_created',
    subName: user.name,
    company: user.company,
    projectName: `${newJob.customerName} - ${newJob.lossType}`,
    notes: `Job #${newJob.id} created for ${newJob.customerName} at ${newJob.propertyAddress}`
  });

  res.json({ success: true, job: newJob });
});

// 5e. Jobs: Delete Job (PM only)
app.delete('/api/jobs/:id', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user || user.role !== 'pm') {
    return res.status(403).json({ success: false, error: 'Only Project Managers can delete jobs' });
  }

  const { id } = req.params;
  const job = jobsDb[id];
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  const deletedWoIds = [...job.workOrderIds];

  // Delete all related work orders and line items
  job.workOrderIds.forEach(woId => {
    delete workOrdersDb[woId];
    delete lineItemsDb[woId];
    // Remove from assigned sub lists
    Object.values(usersDb).forEach(u => {
      u.assignedWoIds = u.assignedWoIds.filter(w => w !== woId);
    });
  });

  delete jobsDb[id];
  saveDatabaseState();

  // Synchronize deletion with Google Sheets
  callAppsScript('deleteJob', { jobId: id, woIds: deletedWoIds }).catch(err => {
    console.error('GAS deleteJob sync notice:', err.message);
  });

  // Log activity
  activityLogsDb.unshift({
    id: `act_${Date.now()}`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    type: 'wo_created',
    subName: user.name,
    company: user.company,
    projectName: `${job.customerName} - ${job.lossType}`,
    notes: `Job #${id} (${job.customerName}) and ${deletedWoIds.length} work orders deleted.`
  });

  res.json({ success: true, message: `Job ${id} deleted.` });
});

// 6. Subcontractors directory (for PM assignments & monitoring)
app.get('/api/subcontractors', (req, res) => {
  const subs = Object.values(usersDb)
    .filter(u => u.role === 'subcontractor')
    .map(u => ({
      id: u.id,
      name: u.name,
      company: u.company,
      trade: u.trade || 'Trade Subcontractor',
      phone: u.phone,
      email: u.email,
      assignedWoIds: u.assignedWoIds
    }));
  res.json({ success: true, subcontractors: subs });
});

// 6b. PM Subcontractors Hub: Full Subcontractor Profiles with Live Stats
app.get('/api/pm/subcontractors', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  if (user.role !== 'pm') {
    return res.status(403).json({ success: false, error: 'Access Denied: Only Project Managers can view the Subcontractor Directory.' });
  }

  const subs = Object.values(usersDb)
    .filter(u => u.role === 'subcontractor')
    .map(u => {
      // Calculate work order metrics for this sub
      const subWos = Object.values(workOrdersDb).filter(wo => 
        (wo.assignedSubId && wo.assignedSubId === u.id) ||
        (u.assignedWoIds && u.assignedWoIds.includes(wo.woId))
      );

      const totalJobs = subWos.length;
      const completedJobs = subWos.filter(wo => wo.status === 'Completed').length;
      
      let totalItems = 0;
      let completedItems = 0;
      subWos.forEach(wo => {
        const items = lineItemsDb[wo.woId] || [];
        totalItems += items.length;
        completedItems += items.filter(i => i.status === 'Completed').length;
      });

      // Find last activity
      const lastAct = activityLogsDb.find(a => a.subId === u.id || a.subName === u.name);

      return {
        id: u.id,
        name: u.name,
        company: u.company,
        trade: u.trade || 'Trade Subcontractor',
        email: u.email,
        phone: u.phone || '',
        assignedWoIds: u.assignedWoIds,
        totalJobs,
        completedJobs,
        totalItems,
        completedItems,
        lastActive: lastAct ? lastAct.timestamp : 'Recently registered',
        tempPassword: u.tempPassword || ''
      };
    });

  res.json({ success: true, subcontractors: subs });
});

// 6c. PM Creates a New Subcontractor Profile & Direct Invite
app.post('/api/pm/subcontractors', (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    if (user.role !== 'pm') {
      return res.status(403).json({ success: false, error: 'Access Denied: Only Project Managers can create subcontractors.' });
    }

    const { name, company, trade, email, phone, password } = req.body;
    if (!name || !company || !email) {
      return res.status(400).json({ success: false, error: 'Name, Company, and Email are required.' });
    }

    // Check if email already exists
    const cleanEmail = String(email || '').trim().toLowerCase();
    const existing = Object.values(usersDb).find(u => String(u?.email || '').toLowerCase().trim() === cleanEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: `Subcontractor with email ${email} already exists.` });
    }

    const subId = `usr_sub_${Date.now().toString(36)}`;
    const subSalt = `salt_sub_${Date.now()}`;
    const initialPassword = String(password || '').trim() || crypto.randomBytes(12).toString('base64url');
    const passwordHash = hashPassword(initialPassword, subSalt);

    const newSub: UserRecord = {
      id: subId,
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role: 'subcontractor',
      company: company.trim(),
      trade: trade?.trim() || 'General Trade',
      phone: phone?.trim() || '',
      assignedWoIds: [],
      permissions: [
        'view_assigned_work_orders',
        'upload_inspection_photo',
        'sign_off_work_order'
      ],
      salt: subSalt,
      passwordHash,
      tempPassword: initialPassword,
      password: initialPassword,
      createdAt: new Date().toISOString()
    };

    usersDb[subId] = newSub;
    saveDatabaseState();

    // Create session token for quick login
    const token = generateSecureToken(newSub);
    sessionsDb[token] = {
      token,
      userId: subId,
      expiresAt: Date.now() + SEVEN_DAYS_MS
    };

    // Record activity
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    activityLogsDb.unshift({
      id: `act_${Date.now()}`,
      timestamp: nowTime,
      type: 'sub_created',
      subId: newSub.id,
      subName: newSub.name,
      company: newSub.company,
      taskDescription: `Onboarded new subcontractor crew for ${newSub.trade}`,
      notes: `PM ${user.name} created account. Login credentials sent to ${newSub.email}`
    });

    // Synchronize to Google Sheets Subcontractors tab with password
    callAppsScript('registerSubcontractor', {
      company: newSub.company,
      name: newSub.name,
      trade: newSub.trade,
      email: newSub.email,
      phone: newSub.phone,
      password: initialPassword
    }).catch(e => console.error('Cloud sheet PM sub creation sync notice:', e.message));

    res.json({
      success: true,
      message: `Subcontractor ${newSub.name} (${newSub.company}) created successfully.`,
      subcontractor: {
        id: newSub.id,
        name: newSub.name,
        company: newSub.company,
        trade: newSub.trade,
        email: newSub.email,
        phone: newSub.phone,
        assignedWoIds: [],
        totalJobs: 0,
        completedJobs: 0,
        totalItems: 0,
        completedItems: 0,
        tempPassword: initialPassword,
        token
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6c. Delete Subcontractor (PM only)
app.delete('/api/pm/subcontractors/:id', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user || user.role !== 'pm') {
    return res.status(403).json({ success: false, error: 'Only Project Managers can delete subcontractors' });
  }

  const { id } = req.params;
  const sub = usersDb[id];
  if (!sub) {
    return res.status(404).json({ success: false, error: 'Subcontractor not found' });
  }

  const subEmail = sub.email;
  const subName = sub.name;
  const subCompany = sub.company;

  delete usersDb[id];

  // Remove active sessions for this sub
  Object.keys(sessionsDb).forEach(t => {
    if (sessionsDb[t].userId === id) {
      delete sessionsDb[t];
    }
  });
  saveDatabaseState();

  // Synchronize deletion with Google Sheets
  callAppsScript('deleteSubcontractor', { subId: id, email: subEmail }).catch(err => {
    console.error('GAS deleteSubcontractor sync error:', err.message);
  });

  const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  activityLogsDb.unshift({
    id: `act_${Date.now()}`,
    timestamp: nowTime,
    type: 'sub_created',
    subId: id,
    subName,
    company: subCompany,
    taskDescription: `Removed subcontractor account ${subCompany}`,
    notes: `Deleted by PM ${user.name}`
  });

  res.json({ success: true, message: `Subcontractor ${subCompany} deleted successfully.` });
});

// 6d. Real-Time Activity Feed for Project Managers
app.get('/api/pm/activity-feed', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  // Return latest 50 events
  res.json({
    success: true,
    events: activityLogsDb.slice(0, 50),
    timestamp: Date.now()
  });
});

// ---------------------------------------------------------------------------
// 6d. Estimate scope helpers shared by the extractor and work order routes
// ---------------------------------------------------------------------------

/** Case/format-insensitive key used to pair a task string with its source scope line. */
function scopeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const FIELD_UNIT_RE = /^(?:sf|sq ?ft|square feet?|ft2|lft|lf|linear feet?|ft|feet|in|inch(?:es)?|ea|each|hr|hours?|ls|lot|cy|cubic yards?|sy|sq|square|til|squares?|rf|bf|gal|gallons?|lb|lbs|pounds?|pr|pairs?|cs|cases?|bdl|bundles?|pc|pieces?|rolls?|pails?|qt|quarts?|bags?|days?|weeks?|no|tile)$/i;

/**
 * Split a stored task string back into its description and measurement. Tasks are
 * saved as "description (12 SF)" while the source scope line may be bare, so the
 * lookup needs both halves to pair a task with its instruction.
 */
function splitTaskMeasurement(task: string): { description: string; quantity: string; unit: string } {
  const text = String(task || '').replace(/\s{2,}/g, ' ').trim();
  const whole = { description: text, quantity: '', unit: '' };
  const trailing = text.match(/[(\[]?\s*(\d+(?:[.,]\d+)?)\s*([A-Za-z]{1,10})?\s*[)\]]?\s*$/);
  if (!trailing || trailing.index === undefined) return whole;
  const unit = (trailing[2] || '').trim();
  const tail = text.slice(trailing.index);
  // A bare trailing number only counts when a unit or a bracket marks it as a measurement.
  if (!unit && !/[(\[]/.test(tail)) return whole;
  if (unit && !FIELD_UNIT_RE.test(unit)) return whole;
  const description = text.slice(0, trailing.index).replace(/[\s\-–—:|,;/]+$/, '').trim();
  if (description.length < 3) return whole;
  return { description, quantity: trailing[1].replace(/,/g, ''), unit: unit.toUpperCase() };
}

/** Every key a task or scope line might be stored under, with and without its measurement. */
function scopeKeys(text: string): string[] {
  const base = scopeKey(text);
  const keys = base ? [base] : [];
  const loose = scopeKey(splitTaskMeasurement(text).description);
  if (loose && loose !== base) keys.push(loose);
  return keys;
}

/** Collapse whitespace, drop blanks and remove duplicate tasks (case/format insensitive). */
function normalizeTaskList(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tasks) {
    if (typeof raw !== 'string') continue;
    // Field crews never see pricing, unit rates or Xactimate codes.
    const task = sanitizeFieldScope(raw).replace(/\s{2,}/g, ' ').trim();
    const key = scopeKey(task);
    if (task.length < 3 || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(task.slice(0, 400));
    if (out.length >= 120) break;
  }
  return out;
}

/** Pair every scope line item with the plain-English instruction that explains it. */
function taskInstructionMap(lineItems: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(lineItems)) return map;
  for (const entry of lineItems) {
    if (!entry || typeof entry !== 'object') continue;
    const description = (entry as any).description;
    const instruction = (entry as any).instruction;
    if (typeof description !== 'string' || typeof instruction !== 'string') continue;
    const text = sanitizeFieldScope(instruction).replace(/\s{2,}/g, ' ').trim();
    if (!text) continue;
    for (const key of scopeKeys(sanitizeFieldScope(description))) {
      if (!map.has(key)) map.set(key, text.slice(0, 400));
    }
  }
  return map;
}

/** Look an instruction up by task text, tolerating a task that carries its measurement. */
function lookupInstruction(map: Map<string, string>, task: string): string | undefined {
  const direct = map.get(scopeKey(task));
  if (direct) return direct;
  for (const key of scopeKeys(task)) {
    const found = map.get(key);
    if (found) return found;
  }
  return undefined;
}

/** The crew-ready instruction for a task, regenerated with its real quantity when unmatched. */
function instructionForTask(map: Map<string, string>, task: string, trade: string): string {
  const matched = lookupInstruction(map, task);
  if (matched) return matched;
  const parts = splitTaskMeasurement(task);
  return buildFieldInstruction(parts.description, parts.quantity, parts.unit, trade);
}

/**
 * Pick the field-work-order section(s) that belong to a trade. Crews only ever
 * receive their own trade's package - never another crew's scope.
 */
function fieldPackageForTrade(pkg: unknown, trade: string | undefined): FieldWorkOrderSection[] {
  const sections = normalizeFieldPackage(pkg);
  if (sections.length === 0) return [];
  const wanted = scopeKey(String(trade || ''));
  if (!wanted) return [];
  const exact = sections.filter((section) => scopeKey(section.tradeName) === wanted);
  if (exact.length > 0) return exact;
  return sections.filter((section) => {
    const name = scopeKey(section.tradeName);
    return name.includes(wanted) || wanted.includes(name);
  });
}

/** Keep only the field-package shape the UI renders, and drop anything empty. */
function normalizeFieldPackage(value: unknown): FieldWorkOrderSection[] {
  if (!Array.isArray(value)) return [];
  const stringList = (input: unknown, max: number): string[] => {
    if (!Array.isArray(input)) return [];
    const out: string[] = [];
    for (const entry of input) {
      if (typeof entry !== 'string') continue;
      const text = sanitizeFieldScope(entry).replace(/\s{2,}/g, ' ').trim();
      if (!text) continue;
      out.push(text.slice(0, 400));
      if (out.length >= max) break;
    }
    return out;
  };

  const sections: FieldWorkOrderSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const tradeName = String((raw as any).tradeName || '').trim().slice(0, 80);
    if (!tradeName) continue;
    const rooms = Array.isArray((raw as any).rooms)
      ? (raw as any).rooms
        .filter((room: any) => room && typeof room === 'object')
        .map((room: any) => ({
          roomName: sanitizeFieldScope(String(room.roomName || 'General')).slice(0, 60) || 'General',
          instructions: stringList(room.instructions, 8)
        }))
        .filter((room: any) => room.instructions.length > 0)
        .slice(0, 10)
      : [];
    sections.push({
      tradeName,
      scopeSummary: sanitizeFieldScope(String((raw as any).scopeSummary || '')).slice(0, 500),
      safetyProtocols: stringList((raw as any).safetyProtocols, 6),
      rooms,
      materials: stringList((raw as any).materials, 8),
      qualityChecks: stringList((raw as any).qualityChecks, 6),
      exclusions: stringList((raw as any).exclusions, 8)
    });
    if (sections.length >= 8) break;
  }
  return sections.filter((section) =>
    section.scopeSummary || section.rooms.length > 0 || section.exclusions.length > 0
  );
}

function hashScope(parts: (string | undefined | null)[]): string {
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 24);
}

/**
 * Scope fingerprint for a work order. Records hydrated from Google Sheets do not
 * carry `scopeHash`, so it is recomputed from the stored line items - that keeps
 * duplicate detection working after a cold start.
 */
function workOrderScopeHash(wo: WorkOrder): string {
  if (wo.scopeHash) return wo.scopeHash;
  const tasks = normalizeTaskList((lineItemsDb[wo.woId] || []).map((item) => item.taskDescription));
  if (tasks.length === 0) return '';
  return hashScope([wo.jobId || wo.sourceJobId || '', wo.trade || '', wo.unitArea || '', ...tasks]);
}

/** Collision-free sequential ids - random ids used to silently overwrite records. */
function allocateWorkOrderId(): string {
  return nextSequentialId('WO-', Object.keys(workOrdersDb), 4);
}

function allocateJobId(): string {
  return nextSequentialId('JOB-', Object.keys(jobsDb), 4);
}

function attachWorkOrders(job: JobRecord) {
  return {
    ...job,
    workOrders: job.workOrderIds.map((woId) => workOrdersDb[woId]).filter(Boolean)
  };
}

/** Payload shape the PM "Upload Estimate" page consumes. */
function toExtractedJobPayload(extraction: EstimateExtraction) {
  return {
    projectName: extraction.projectName,
    customerName: extraction.customerName,
    insuredName: extraction.customerName,
    propertyAddress: extraction.propertyAddress,
    phone: extraction.phone,
    email: extraction.email,
    claimNumber: extraction.claimNumber,
    insuranceCarrier: extraction.insuranceCarrier,
    adjusterName: extraction.adjusterName,
    lossType: extraction.lossType,
    dateOfLoss: extraction.dateOfLoss,
    unitArea: extraction.unitArea,
    totalEstimate: extraction.totalEstimate,
    notes: extraction.notes,
    suggestedTrade: extraction.suggestedTrade,
    tasks: extraction.tasks,
    tradeBreakdown: extraction.tradeBreakdown,
    roomBreakdown: extraction.roomBreakdown,
    lineItems: extraction.lineItems,
    fieldPackage: extraction.fieldPackage,
    confidence: extraction.confidence,
    warnings: extraction.warnings,
    extractionMethod: extraction.extractionMethod,
    source: extraction.source,
    sourceHash: extraction.sourceHash,
    documentStats: extraction.documentStats
  };
}

/** Rebuild the extraction payload for an estimate that was already processed. */
function jobToExtractedPayload(job: JobRecord) {
  return {
    projectName: `${job.customerName || 'Restoration Job'} - ${job.lossType || 'Restoration'}`,
    customerName: job.customerName || '',
    insuredName: job.customerName || '',
    propertyAddress: job.propertyAddress || '',
    phone: job.phone || '',
    email: job.email || '',
    claimNumber: job.claimNumber || '',
    insuranceCarrier: '',
    adjusterName: '',
    lossType: job.lossType || 'Restoration',
    dateOfLoss: '',
    unitArea: job.scopeSummary || '',
    totalEstimate: job.totalEstimate || '',
    notes: job.notes || '',
    suggestedTrade: job.extractedTrades && job.extractedTrades[0] ? job.extractedTrades[0].tradeName : '',
    tasks: job.extractedTasks || [],
    tradeBreakdown: job.extractedTrades || [],
    roomBreakdown: [],
    lineItems: [],
    fieldPackage: normalizeFieldPackage(job.fieldPackage),
    confidence: job.extractionConfidence ?? 0,
    warnings: job.extractionWarnings || [],
    extractionMethod: job.extractionMethod || 'stored_extraction',
    source: 'pdf',
    sourceHash: job.sourceHash || '',
    documentStats: job.documentStats
  };
}

// ---------------------------------------------------------------------------
// 6e. ESTIMATE EXTRACTION (real PDF text layer or pasted text -> job scope)
//
// The extractor reads the submitted document only: PDF text is unpacked
// (FlateDecode/ASCII streams, string escapes, ToUnicode CMaps) and the scope
// rows are mapped onto the seven Hays + Sons crews. AI enrichment is optional
// and strictly validated - nothing is returned that is not in the document, and
// re-processing the same estimate reuses the existing job instead of creating
// another identical batch of work orders.
// ---------------------------------------------------------------------------
app.post('/api/ai/extract-job-from-pdf', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
    }
    if (user.role !== 'pm') {
      return res.status(403).json({ success: false, error: 'Access Denied: Only Project Managers can extract and create jobs from estimates.' });
    }

    const {
      pdfBase64,
      mimeType,
      fileName,
      textSnippet,
      autoCreate,
      assignedSubId,
      customSubName,
      scheduledDate
    } = req.body || {};

    // Accept both legacy client field names (base64/rawText) and the current
    // names (pdfBase64/textSnippet) so the PM Upload Estimate page never fails.
    const resolvedBase64 = (pdfBase64 || req.body?.base64 || '').toString().trim();
    const resolvedText = (textSnippet || req.body?.rawText || req.body?.text || '').toString().trim();

    if (!resolvedBase64 && !resolvedText) {
      return res.status(400).json({
        success: false,
        error: 'Please upload an estimate PDF or paste the estimate text to extract the project scope.'
      });
    }

    const approxBytes = Math.ceil(resolvedBase64.replace(/\s+/g, '').length * 0.75);
    if (approxBytes > 20 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: 'That estimate file is larger than the 20 MB limit. Upload the scope pages only or paste the text.'
      });
    }

    const extraction = await extractEstimate({
      pdfBase64: resolvedBase64 || undefined,
      mimeType: mimeType || undefined,
      textSnippet: resolvedText || undefined,
      fileName: fileName || undefined,
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
      timeoutMs: process.env.AI_EXTRACT_TIMEOUT_MS ? Number(process.env.AI_EXTRACT_TIMEOUT_MS) : undefined
    });

    const data = toExtractedJobPayload(extraction);
    const canAutoCreate = Boolean(autoCreate);

    // Idempotency: the same document must never produce a second job or a second
    // identical batch of work orders.
    const existingJob = !req.body?.forceNew
      ? Object.values(jobsDb).find((job) => job.sourceHash && job.sourceHash === extraction.sourceHash)
      : undefined;

    if (existingJob) {
      return res.json({
        success: true,
        duplicate: true,
        method: existingJob.extractionMethod || extraction.extractionMethod,
        data: jobToExtractedPayload(existingJob),
        job: attachWorkOrders(existingJob),
        autoCreated: existingJob.workOrderIds.length > 0,
        workOrder: existingJob.workOrderIds.map((woId) => workOrdersDb[woId]).filter(Boolean)[0] || null,
        lineItems: existingJob.workOrderIds.flatMap((woId) => lineItemsDb[woId] || []),
        message: `This estimate was already processed as Job #${existingJob.id} with ${existingJob.workOrderIds.length} work order(s). Reusing the existing job instead of creating duplicates.`
      });
    }

    if (extraction.tasks.length === 0) {
      return res.status(422).json({
        success: false,
        method: extraction.extractionMethod,
        error: 'No line-item scope could be read from this document, so no work orders were created. Upload the digital PDF export (not a scan) or paste the scope/line-item table.',
        data,
        warnings: extraction.warnings
      });
    }

    // Create the job from the extracted (document-sourced) scope.
    const jobId = allocateJobId();
    const custName = extraction.customerName || extraction.propertyAddress || 'Property Owner';

    const createdJob: JobRecord = {
      id: jobId,
      customerName: custName,
      propertyAddress: extraction.propertyAddress,
      phone: extraction.phone,
      email: extraction.email,
      claimNumber: extraction.claimNumber,
      lossType: extraction.lossType || 'Restoration',
      totalEstimate: extraction.totalEstimate,
      notes: extraction.notes,
      scopeSummary: extraction.unitArea || 'Restoration Scope',
      extractedTrades: extraction.tradeBreakdown,
      extractedTasks: extraction.tasks,
      fieldPackage: extraction.fieldPackage,
      createdAt: new Date().toISOString(),
      workOrderIds: [],
      sourceHash: extraction.sourceHash,
      extractionMethod: extraction.extractionMethod,
      extractionConfidence: extraction.confidence,
      extractionWarnings: extraction.warnings,
      documentStats: extraction.documentStats
    };

    jobsDb[jobId] = createdJob;

    // Optional one-shot dispatch of every trade group on the job.
    let createdWorkOrder: WorkOrder | null = null;
    let createdLineItems: LineItem[] = [];

    if (canAutoCreate) {
      const suggestedLower = (extraction.suggestedTrade || '').toLowerCase();
      let resolvedSubId = assignedSubId;
      let resolvedSubName = customSubName;
      let resolvedSubPhone = '';

      const subList = Object.values(usersDb).filter((u) => u.role === 'subcontractor');
      if (!resolvedSubId || resolvedSubId === 'custom') {
        const matched = subList.find((s) => {
          const trade = String(s.trade || '').toLowerCase();
          if (!trade) return false;
          if (suggestedLower.includes('plumb') && trade.includes('plumb')) return true;
          if (suggestedLower.includes('elect') && trade.includes('elect')) return true;
          if (suggestedLower.includes('floor') && trade.includes('floor')) return true;
          if (suggestedLower.includes('paint') && trade.includes('paint')) return true;
          if (suggestedLower.includes('clean') && trade.includes('clean')) return true;
          if (suggestedLower.includes('carpent') && trade.includes('carpent')) return true;
          if ((suggestedLower.includes('content') || suggestedLower.includes('demolition')) && (trade.includes('content') || trade.includes('demo'))) return true;
          return false;
        });

        if (matched) {
          resolvedSubId = matched.id;
          resolvedSubName = matched.company || matched.name;
          resolvedSubPhone = matched.phone || '';
        } else if (!resolvedSubName) {
          delete jobsDb[jobId];
          saveDatabaseState();
          return res.status(409).json({
            success: false,
            method: extraction.extractionMethod,
            error: 'No matching subcontractor was found for this scope. Add a subcontractor account for the trade, then dispatch the work order.',
            data,
            warnings: extraction.warnings
          });
        }
      } else if (usersDb[resolvedSubId]) {
        const subUser = usersDb[resolvedSubId];
        resolvedSubName = subUser.company || subUser.name;
        resolvedSubPhone = subUser.phone || '';
      }

      const tasks = normalizeTaskList(extraction.tasks);
      const woId = allocateWorkOrderId();
      const scheduled = scheduledDate || new Date().toISOString().split('T')[0];
      const trade = extraction.suggestedTrade || GENERAL_TRADE;
      const instructions = taskInstructionMap(extraction.lineItems);

      createdWorkOrder = {
        woId,
        jobId,
        projectName: `${custName} - ${trade || extraction.lossType || 'Restoration'}`,
        customerName: custName,
        propertyAddress: extraction.propertyAddress,
        trade,
        unitArea: extraction.unitArea || 'Restoration Scope',
        subName: resolvedSubName || 'Unassigned Subcontractor',
        subPhone: resolvedSubPhone,
        assignedSubId: resolvedSubId,
        scheduledDate: scheduled,
        status: 'Open',
        totalItems: tasks.length,
        completedItems: 0,
        createdBy: user.name,
        scopeHash: hashScope([jobId, extraction.suggestedTrade, ...tasks]),
        sourceJobId: jobId,
        fieldPackage: fieldPackageForTrade(extraction.fieldPackage, trade)
      };

      createdLineItems = tasks.map((taskDescription, idx) => ({
        lineId: `${woId}-L${String(idx + 1).padStart(2, '0')}`,
        woId,
        taskDescription,
        instruction: instructionForTask(instructions, taskDescription, trade),
        status: 'Pending' as const,
        photoUrl: '',
        notes: '',
        timestamp: ''
      }));

      workOrdersDb[woId] = createdWorkOrder;
      lineItemsDb[woId] = createdLineItems;
      createdJob.workOrderIds.push(woId);

      if (resolvedSubId && usersDb[resolvedSubId] && !usersDb[resolvedSubId].assignedWoIds.includes(woId)) {
        usersDb[resolvedSubId].assignedWoIds.push(woId);
      }

      saveDatabaseState();

      // Synchronize with Google Sheets in background (non-blocking).
      callAppsScript('createWorkOrder', {
        jobId,
        woId,
        project: createdWorkOrder.projectName,
        trade: createdWorkOrder.trade,
        assignedSubId: resolvedSubId || '',
        unit: createdWorkOrder.unitArea,
        subName: createdWorkOrder.subName,
        subPhone: resolvedSubPhone,
        subEmail: resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].email : '',
        date: scheduled,
        tasks
      }).catch((err: any) => {
        console.warn('Apps Script background sync notice:', err.message);
      });

      activityLogsDb.unshift({
        id: `act_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'wo_created',
        subId: resolvedSubId,
        subName: createdWorkOrder.subName,
        company: createdWorkOrder.subName,
        woId,
        projectName: createdWorkOrder.projectName,
        notes: `Extracted ${tasks.length} scope items from ${fileName || 'estimate'}: Job #${jobId} created and Work Order #${woId} assigned to ${createdWorkOrder.subName}.`
      });
    } else {
      saveDatabaseState();
    }

    res.json({
      success: true,
      duplicate: false,
      method: extraction.extractionMethod,
      confidence: extraction.confidence,
      warnings: extraction.warnings,
      data,
      job: attachWorkOrders(createdJob),
      autoCreated: Boolean(createdWorkOrder),
      workOrder: createdWorkOrder,
      lineItems: createdLineItems
    });
  } catch (err: any) {
    console.error('Estimate extraction error:', err);
    res.status(500).json({
      success: false,
      error: `Estimate extraction failed: ${String(err?.message || err).slice(0, 300)}`
    });
  }
});

// 7. Fetch list of work orders (Filtered by Role & Assignment)
app.get('/api/work-orders', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
  }

  const allWos = Object.values(workOrdersDb);
  if (user.role === 'pm') {
    return res.json({ success: true, workOrders: allWos });
  }

  // Subcontractor: only return work orders assigned to them
  const assignedWos = allWos.filter(wo => canUserAccessWorkOrder(user, wo.woId, wo));
  res.json({ success: true, workOrders: assignedWos });
});

// 8. Fetch specific Work Order & its line items (Strict Authorization)
app.get('/api/work-orders/:woId', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
  }

  const { woId } = req.params;
  const upperWoId = woId.toUpperCase();
  const wo = workOrdersDb[upperWoId];
  if (!wo) {
    return res.status(404).json({ success: false, error: `Work Order ${woId} not found` });
  }

  // Security barrier: Check if subcontractor is authorized for this work order
  if (!canUserAccessWorkOrder(user, upperWoId, wo)) {
    return res.status(403).json({
      success: false,
      error: `Access Denied: You are not authorized to view Work Order ${woId}. This job is assigned to ${wo.subName}.`
    });
  }

  const items = lineItemsDb[wo.woId] || [];
  res.json({ success: true, workOrder: wo, lineItems: items });
});

// 9. Create new Work Order (Strictly PM Only)
app.post('/api/work-orders', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
    }

    if (user.role !== 'pm') {
      return res.status(403).json({
        success: false,
        error: 'Access Denied: Only Project Managers have permission to create work orders.'
      });
    }

    const {
      jobId,
      projectName,
      customerName,
      propertyAddress,
      trade,
      unitArea,
      subName,
      subPhone,
      scheduledDate,
      tasks,
      assignedSubId,
      force,
      fieldPackage
    } = req.body || {};

    const cleanTasks = normalizeTaskList(tasks);
    if ((!projectName && !jobId) || cleanTasks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'A project (job) and at least 1 task are required to create a work order.'
      });
    }

    const linkedJob = jobId && jobsDb[jobId] ? jobsDb[jobId] : null;
    const finalCustomerName = customerName || (linkedJob ? linkedJob.customerName : '');
    const finalAddress = propertyAddress || (linkedJob ? linkedJob.propertyAddress : '');
    const finalTrade = trade || GENERAL_TRADE;
    const finalProjectName = projectName
      || (finalCustomerName ? `${finalCustomerName} - ${finalTrade}` : `Work Order ${finalTrade}`);
    const finalUnit = unitArea || (linkedJob ? linkedJob.scopeSummary : '') || 'Restoration Scope';
    const scheduled = scheduledDate || new Date().toISOString().split('T')[0];
    const instructions = taskInstructionMap(req.body?.lineItems);
    const tradeFieldPackage = fieldPackageForTrade(
      fieldPackage ?? (linkedJob ? linkedJob.fieldPackage : undefined),
      finalTrade
    );

    // Idempotency: dispatching the identical scope twice returns the existing work
    // order instead of appending a duplicate (this is what used to look like the
    // app "reloading the same fake work order").
    const scopeHash = hashScope([jobId || '', finalTrade, finalUnit, ...cleanTasks]);
    if (!force) {
      const duplicate = Object.values(workOrdersDb).find((wo) => workOrderScopeHash(wo) === scopeHash);
      if (duplicate) {
        return res.json({
          success: true,
          duplicate: true,
          woId: duplicate.woId,
          workOrder: duplicate,
          lineItems: lineItemsDb[duplicate.woId] || [],
          message: `This exact scope is already dispatched as Work Order #${duplicate.woId}.`
        });
      }
    }

    let resolvedSubId = assignedSubId;
    // Auto-link to an existing subcontractor account by name or phone.
    if (!resolvedSubId) {
      const matchedSub = Object.values(usersDb).find((u) =>
        u.role === 'subcontractor' && (
          (subPhone && u.phone && u.phone.replace(/\D/g, '') === String(subPhone).replace(/\D/g, '')) ||
          (subName && String(u.company || '').toLowerCase().trim() === String(subName).toLowerCase().trim())
        )
      );
      if (matchedSub) resolvedSubId = matchedSub.id;
    }

    const woId = allocateWorkOrderId();

    const newWo: WorkOrder = {
      woId,
      jobId: jobId || undefined,
      projectName: finalProjectName,
      customerName: finalCustomerName,
      propertyAddress: finalAddress,
      trade: finalTrade,
      unitArea: finalUnit,
      subName: subName || (resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].company : '') || 'Unassigned Subcontractor',
      subPhone: subPhone || (resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].phone || '' : ''),
      assignedSubId: resolvedSubId,
      scheduledDate: scheduled,
      status: 'Open',
      totalItems: cleanTasks.length,
      completedItems: 0,
      createdBy: user.name,
      scopeHash,
      sourceJobId: jobId || undefined,
      fieldPackage: tradeFieldPackage
    };

    const newLines: LineItem[] = cleanTasks.map((taskDesc, idx) => ({
      lineId: `${woId}-L${String(idx + 1).padStart(2, '0')}`,
      woId,
      taskDescription: taskDesc,
      instruction: instructionForTask(instructions, taskDesc, finalTrade),
      status: 'Pending',
      photoUrl: '',
      timestamp: ''
    }));

    workOrdersDb[woId] = newWo;
    lineItemsDb[woId] = newLines;

    if (linkedJob && !linkedJob.workOrderIds.includes(woId)) {
      linkedJob.workOrderIds.push(woId);
    }

    if (resolvedSubId && usersDb[resolvedSubId] && !usersDb[resolvedSubId].assignedWoIds.includes(woId)) {
      usersDb[resolvedSubId].assignedWoIds.push(woId);
    }

    saveDatabaseState();

    // Synchronize with Google Sheets database tabs (WorkOrders and LineItems).
    try {
      await callAppsScript('createWorkOrder', {
        jobId: jobId || '',
        woId,
        project: finalProjectName,
        trade: finalTrade,
        assignedSubId: resolvedSubId || '',
        unit: finalUnit,
        subName: newWo.subName,
        subPhone: newWo.subPhone,
        subEmail: resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].email : '',
        date: scheduled,
        tasks: cleanTasks
      });
    } catch (gasErr: any) {
      console.warn('Apps Script createWorkOrder sync notice:', gasErr.message);
    }

    // Record real-time event for PM & Subcontractor streams
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    activityLogsDb.unshift({
      id: `act_${Date.now()}`,
      timestamp: nowTime,
      type: 'wo_created',
      subId: resolvedSubId,
      subName: newWo.subName,
      company: newWo.subName,
      woId,
      projectName: newWo.projectName,
      taskDescription: `Dispatched ${newLines.length} tasks to ${newWo.subName} (${finalUnit})`,
      notes: `Created by ${user.name}`
    });

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const magicLink = `${protocol}://${host}/?woId=${woId}`;

    res.json({
      success: true,
      duplicate: false,
      woId,
      magicLink,
      workOrder: newWo,
      lineItems: newLines
    });
  } catch (err: any) {
    console.error('Create work order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9b. Delete Work Order (Strictly PM Only)
app.delete('/api/work-orders/:woId', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user || user.role !== 'pm') {
    return res.status(403).json({ success: false, error: 'Only Project Managers can delete work orders' });
  }

  const { woId } = req.params;
  const upperWoId = woId.toUpperCase();
  const wo = workOrdersDb[upperWoId];
  if (!wo) {
    return res.status(404).json({ success: false, error: 'Work order not found' });
  }

  // Detach from parent Job
  if (wo.jobId && jobsDb[wo.jobId]) {
    jobsDb[wo.jobId].workOrderIds = jobsDb[wo.jobId].workOrderIds.filter(id => id !== upperWoId);
  }

  // Detach from Subcontractors
  Object.values(usersDb).forEach(u => {
    u.assignedWoIds = u.assignedWoIds.filter(id => id !== upperWoId);
  });

  delete workOrdersDb[upperWoId];
  delete lineItemsDb[upperWoId];
  saveDatabaseState();

  // Synchronize deletion with Google Sheets
  callAppsScript('deleteWorkOrder', { woId: upperWoId }).catch(err => {
    console.error('GAS deleteWorkOrder sync notice:', err.message);
  });

  // Log activity
  activityLogsDb.unshift({
    id: `act_${Date.now()}`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    type: 'wo_created',
    subName: user.name,
    company: user.company,
    projectName: wo.projectName || upperWoId,
    notes: `Work Order ${upperWoId} deleted by PM ${user.name}`
  });

  res.json({ success: true, message: `Work Order ${upperWoId} deleted.` });
});

// 10. Photo Upload & Line-Item Verification (Basic Direct Field Verification)
app.post('/api/verify-photo', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
    }

    const { lineId, woId, base64Image, mimeType, taskDescription } = req.body;
    if (!lineId || !base64Image || !taskDescription) {
      return res.status(400).json({ success: false, error: 'lineId, base64Image, and taskDescription are required' });
    }

    const targetWoId = (woId || lineId.split('-L')[0]).toUpperCase();
    const wo = workOrdersDb[targetWoId];
    if (wo && !canUserAccessWorkOrder(user, targetWoId, wo)) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: You are not authorized to submit inspection photos for Work Order ${targetWoId}.`
      });
    }

    const cleanBase64 = base64Image.includes('base64,')
      ? base64Image.split('base64,')[1]
      : base64Image;

    const photoUrl = base64Image.startsWith('data:') ? base64Image : `data:${mimeType || 'image/jpeg'};base64,${cleanBase64}`;
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Update in-memory DB
    const items = lineItemsDb[targetWoId];
    if (items) {
      const item = items.find(i => i.lineId === lineId);
      if (item) {
        item.status = 'Completed';
        item.photoUrl = photoUrl;
        item.timestamp = nowTime;
      }

      // Update work order progress
      const targetWo = workOrdersDb[targetWoId];
      if (targetWo) {
        const completed = items.filter(i => i.status === 'Completed').length;
        targetWo.completedItems = completed;
        targetWo.status = (completed === items.length && items.length > 0)
          ? 'Completed'
          : (completed > 0 ? 'In Progress' : 'Open');
      }
      saveDatabaseState();

      // Log real-time inspection event for PM
      activityLogsDb.unshift({
        id: `act_${Date.now()}`,
        timestamp: nowTime,
        type: 'photo_uploaded',
        subId: user.id,
        subName: user.name,
        company: user.company,
        woId: targetWoId,
        projectName: targetWo?.projectName || targetWoId,
        lineId,
        taskDescription,
        verdict: 'PASS',
        photoUrl
      });

      // Synchronize inspection photo to Google Drive & update LineItems sheet in background
      callAppsScript('verifyPhoto', {
        lineId,
        taskDescription,
        base64Image: cleanBase64,
        mimeType: mimeType || 'image/jpeg',
        subcontractorName: user.name
      }).then(driveRes => {
        if (driveRes && driveRes.success && driveRes.photoUrl) {
          const targetItems = lineItemsDb[targetWoId];
          const targetItem = targetItems ? targetItems.find(i => i.lineId === lineId) : null;
          if (targetItem) {
            targetItem.photoUrl = driveRes.photoUrl;
          }
        }
      }).catch(driveErr => console.error('Google Drive photo upload sync notice:', driveErr.message));
    }

    const updatedWo = workOrdersDb[targetWoId];
    const completedCount = updatedWo ? updatedWo.completedItems : 1;
    const totalCount = updatedWo ? updatedWo.totalItems : 1;

    res.json({
      success: true,
      lineId,
      status: 'Completed',
      photoUrl,
      completedCount,
      totalCount,
      isComplete: completedCount === totalCount
    });
  } catch (err: any) {
    console.error('Photo upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Sign-off Work Order
app.post('/api/work-orders/:woId/sign-off', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please sign in.' });
  }

  const { woId } = req.params;
  const { signatureName } = req.body || {};
  const upperWoId = woId.toUpperCase();
  const wo = workOrdersDb[upperWoId];
  if (!wo) {
    return res.status(404).json({ success: false, error: 'Work Order not found' });
  }

  if (!canUserAccessWorkOrder(user, upperWoId, wo)) {
    return res.status(403).json({
      success: false,
      error: `Access Denied: You are not authorized to sign off Work Order ${woId}. This job is assigned to ${wo.subName}.`
    });
  }

  const items = lineItemsDb[wo.woId] || [];
  const incomplete = items.filter(i => i.status !== 'Completed');
  if (incomplete.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Cannot sign off. ${incomplete.length} item(s) are not verified yet.`
    });
  }

  wo.status = 'Completed';
  wo.signedBy = (signatureName && typeof signatureName === 'string' && signatureName.trim()) 
    ? signatureName.trim() 
    : user.name;
  wo.signedAt = new Date().toLocaleString();
  saveDatabaseState();

  // Log sign-off event in real-time activity stream
  const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  activityLogsDb.unshift({
    id: `act_${Date.now()}`,
    timestamp: nowTime,
    type: 'sub_signed_off',
    subId: user.id,
    subName: user.name,
    company: user.company,
    woId,
    projectName: wo.projectName,
    taskDescription: `All ${items.length} line items completed & officially signed off`,
    notes: `Electronic sign-off executed by ${wo.signedBy}`
  });

  // Synchronize sign-off to Google Sheet
  callAppsScript('signOff', {
    woId,
    signerName: wo.signedBy
  }).catch(e => console.error('Sheet sign-off sync notice:', e.message));

  res.json({
    success: true,
    message: `Work Order ${woId} successfully signed off and completed.`,
    workOrder: wo
  });
});

// 12. Google Apps Script Cloud Sync Status and Config
app.get('/api/cloud-sync/status', async (req, res) => {
  const effectiveUrl = getEffectiveAppsScriptUrl();
  const isConfigured = Boolean(effectiveUrl);
  let isReachable = false;
  let message = 'Google Apps Script cloud sync is not configured.';

  if (isConfigured) {
    try {
      const ping = await callAppsScript('ping', {});
      if (ping && ping.success) {
        isReachable = true;
        message = 'Connected to Google Sheets & Drive (Hays + Sons FieldProof).';
      } else {
        isReachable = true;
        message = 'Connected to Google Apps Script endpoint.';
      }
    } catch (err: any) {
      message = 'Failed to reach Google Apps Script: ' + err.message;
    }
  }

  res.json({
    success: true,
    configured: isConfigured,
    online: isReachable,
    message,
    isCustom: Boolean(customAppsScriptUrl),
    provider: 'Google Sheets & Google Drive'
  });
});

app.get('/api/cloud-sync/config', (req, res) => {
  const effectiveUrl = getEffectiveAppsScriptUrl();
  res.json({
    success: true,
    hasUrl: Boolean(effectiveUrl),
    isCustom: Boolean(customAppsScriptUrl),
    url: customAppsScriptUrl || ''
  });
});

app.post('/api/cloud-sync/config', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim().startsWith('https://script.google.com/macros/s/')) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid Google Apps Script Web App URL (starts with https://script.google.com/macros/s/...)'
    });
  }

  customAppsScriptUrl = url.trim();
  saveDatabaseState();

  let isReachable = false;
  let details = '';
  try {
    const testPing = await callAppsScript('ping', {});
    if (testPing) {
      isReachable = true;
      details = 'Connection verified with Google Apps Script.';
      await syncFromGoogleSheets();
    } else {
      details = 'URL saved. Awaiting response from Apps Script.';
    }
  } catch (err: any) {
    details = 'Sync notice: ' + err.message;
  }

  res.json({
    success: true,
    message: isReachable ? 'Google Apps Script URL saved and verified!' : 'URL saved. ' + details,
    online: isReachable,
    details
  });
});

// Catch-all 404 handler for API routes to guarantee JSON response format (never HTML)
app.all('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API route not found: ${req.method} ${req.originalUrl || req.url}`
  });
});

// Global error handler guaranteeing valid JSON output
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('FieldProof server error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'An unexpected server error occurred.'
  });
});

// This module intentionally only creates and exports the application. Vercel
// imports it as a serverless handler, so binding an HTTP port here is invalid.
export { app };
export default app;
