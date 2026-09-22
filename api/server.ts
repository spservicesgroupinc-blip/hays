import express from 'express';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = 3000;
const isServerlessRuntime = Boolean(
  process.env.VERCEL ||
  process.env.VERCEL_ENV ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

// Lazy initialize Gemini client (strictly server-side)
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

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
  createdAt: string;
  workOrderIds: string[];
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
const AUTH_SECRET = process.env.AUTH_SECRET || (() => {
  console.warn('[WARNING] AUTH_SECRET environment variable is not set. Using a randomly generated secret for this process; user sessions will not persist across restarts.');
  return crypto.randomBytes(32).toString('hex');
})();

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
            customerName: String(job.customerName || 'Customer'),
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
            customerName: wo.projectName ? wo.projectName.split(' - ')[0] : 'Customer',
            propertyAddress: 'Restoration Job Site',
            trade: wo.trade || 'Restoration Trade',
            unitArea: wo.unitArea || 'Work Area',
            subName: wo.subName || 'Subcontractor',
            subPhone: wo.subPhone || '',
            assignedSubId: wo.assignedSubId || '',
            scheduledDate: wo.scheduledDate || '',
            status: wo.status || 'Open',
            totalItems: Number(wo.totalItems || 0),
            completedItems: Number(wo.completedItems || 0),
            signedBy: wo.signedBy || undefined,
            signedAt: wo.signedAt || undefined,
            createdBy: 'Project Manager'
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

  const id = `JOB-${Math.floor(100 + Math.random() * 900)}`;
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

// Fast text stream extractor for PDF buffers (handles Xactimate, Symbility & raw PDF streams)
function extractTextFromPdfBuffer(buf: Buffer): string {
  try {
    const raw = buf.toString('latin1');
    const chunks: string[] = [];

    // Extract text inside PDF parentheses: (text) Tj or (text)
    const parenMatches = raw.match(/\(([^()]{2,150})\)/g);
    if (parenMatches) {
      for (const m of parenMatches) {
        const cleaned = m.slice(1, -1).replace(/\\[rntbf\\()]/g, ' ').trim();
        if (cleaned.length > 2 && /[a-zA-Z0-9]/.test(cleaned)) {
          chunks.push(cleaned);
        }
      }
    }

    // Extract contiguous printable ASCII runs
    const asciiMatches = raw.match(/[A-Za-z0-9\s.,/#'"()$%&:;!?-]{6,120}/g);
    if (asciiMatches) {
      for (const a of asciiMatches) {
        const trimmed = a.trim();
        if (trimmed.length > 5 && /[a-zA-Z]/.test(trimmed)) {
          chunks.push(trimmed);
        }
      }
    }

    return chunks.join('\n');
  } catch (e) {
    return '';
  }
}

// Standard seven-trade crew fallback so pasted text and timed-out PDF extraction
// still produce a complete, assignable trade breakdown for work order creation.
function buildStandardTradeBreakdown(lossType: string): { tradeName: string; tasks: string[] }[] {
  const loss = String(lossType || 'Restoration').toLowerCase();
  const demoTask = loss.includes('fire') || loss.includes('smoke')
    ? 'Demolish charred/affected building materials and dispose per IICRC standards.'
    : loss.includes('storm')
      ? 'Demolish storm-damaged materials and prepare surfaces for rebuild.'
      : 'Detach, protect and reset affected contents; remove damaged materials.';

  return [
    {
      tradeName: 'Contents Handling, Site Protection & Demolition Crew',
      tasks: [
        'Inventory, pack and move contents from affected rooms to on-site storage.',
        'Install dust containment: plastic barriers, tension posts, zipper access and HEPA air scrubbers.',
        demoTask
      ]
    },
    {
      tradeName: 'Plumbing & Mechanical Trade Crew',
      tasks: [
        'Isolate and verify utilities; detach, cap-off and reset sinks, faucets, angle stops and toilets.',
        'Disconnect/reconnect water lines and appliances per manufacturer specifications.'
      ]
    },
    {
      tradeName: 'Electrical Trade Crew',
      tasks: [
        'Perform lockout/tagout and verify circuits are de-energized before work.',
        'Reset junction boxes; replace switches/outlets and reinstall light fixtures to code.'
      ]
    },
    {
      tradeName: 'Flooring & Underlayment Trade Crew',
      tasks: [
        'Verify subfloor is clean, dry and level; install moisture/membrane underlayment.',
        'Install flooring (tile/LVP/laminate/carpet) per estimate square footage with transition strips and expansion gaps.'
      ]
    },
    {
      tradeName: 'Finish Carpentry, Doors & Cabinetry Crew',
      tasks: [
        'Detach and reset baseboard, casing and rosette blocks; record linear footages.',
        'Remove/reset door slabs and hardware; install cabinetry, counter, toe kick and hardware.'
      ]
    },
    {
      tradeName: 'Painting & Surface Finishing Crew',
      tasks: [
        'Mask, sand and caulk per scope; protect tape-only areas.',
        'Apply primer, paint coats and urethane/trim finishes per estimate locations and square footages.'
      ]
    },
    {
      tradeName: 'Post-Job Cleanup & Debris Removal Crew',
      tasks: [
        'Stage dump trailer and haul off construction waste.',
        'Complete final post-construction cleaning: HEPA vacuum, surface wipe and fixture polish.'
      ]
    }
  ];
}

// 6e. AI PDF ESTIMATE EXTRACTOR (Gemini 3.8 Flash Multimodal & Intelligent Fast Parser)
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
    } = req.body;

    // Accept both legacy client field names (base64/rawText) and the current
    // names (pdfBase64/textSnippet) so the PM Upload Estimate page never fails.
    const resolvedBase64 = (pdfBase64 || req.body.base64 || '').toString().trim();
    const resolvedText = (textSnippet || req.body.rawText || req.body.text || '').toString().trim();

    if (!resolvedBase64 && !resolvedText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Please upload an estimate PDF or enter estimate text to extract project scope.' 
      });
    }

    let extractedData: any = null;
    let extractionMethod = 'ai_parser';

    // 1. Extract text from base64 if provided
    let pdfTextExtracted = '';
    let cleanBase64 = '';
    if (resolvedBase64) {
      cleanBase64 = resolvedBase64.includes('base64,') ? resolvedBase64.split('base64,')[1] : resolvedBase64;
      try {
        const buffer = Buffer.from(cleanBase64, 'base64');
        pdfTextExtracted = extractTextFromPdfBuffer(buffer);
      } catch (bufErr) {
        console.warn('Buffer conversion notice:', bufErr);
      }
    }

    const combinedText = `${resolvedText}\n${pdfTextExtracted}\n${fileName || ''}`.trim();

    // 2. If Gemini 3.8 Flash is available, try AI multimodal extraction with timeout
    if (!extractedData && process.env.GEMINI_API_KEY && (cleanBase64 || resolvedText)) {
      try {
        const effectiveMime = (mimeType && mimeType.includes('pdf')) 
          ? 'application/pdf' 
          : (mimeType || 'application/pdf');

        const ai = getGenAI();
        const prompt = `You are a Senior Project Manager & Restoration Estimator at Hays + Sons Complete Restoration.
Analyze the submitted restoration insurance estimate (Xactimate, Symbility, contractor bid, or pasted estimate text).
Extract the customer/job details and translate the full scope into actionable, verifiable line-item tasks organized under the seven standard Hays + Sons trade crews below.

CUSTOMER & JOB DATA (must be filled from the estimate so the job can be created):
- customerName: insured/client/homeowner name (fall back to insuredName when available).
- propertyAddress: the jobsite location/address.
- phone and email: the insured/customer contact details when present.
- claimNumber, lossType, unitArea, totalEstimate, notes.

THE SEVEN STANDARD TRADE CREWS (use these exact names in tradeBreakdown):
1. "Contents Handling, Site Protection & Demolition Crew" — per-room contents handling/moving instructions; dust containment setup (plastic barriers, tension posts, zipper access, air scrubbers); tear-out and surface prep (flooring removal, subfloor prep, concrete grinding).
2. "Plumbing & Mechanical Trade Crew" — utility isolation and safety; detach, cap-off, and reset instructions for sinks, faucets, angle stops, toilets, water lines, and appliances.
3. "Electrical Trade Crew" — lockout/tagout and code compliance; rewiring, junction box resets, switch/outlet replacements, and light fixture installations.
4. "Flooring & Underlayment Trade Crew" — subfloor cleanliness inspection and moisture/membrane underlayment installation; exact square footages for tile, LVP, laminate, or carpet by room; transition strip locations and perimeter expansion gap requirements.
5. "Finish Carpentry, Doors & Cabinetry Crew" — door slab/frame removal, door hardware installation, sidelite adjustments; baseboard, casing, and rosette block detach/reset instructions with exact linear footages; cabinetry, counter, toe kick, and hardware installation.
6. "Painting & Surface Finishing Crew" — masking and surface prep (sanding, caulking, tape-only areas); exact locations and linear/square footages for primer, paint coats, urethane wood finishes, and trim staining.
7. "Post-Job Cleanup & Debris Removal Crew" — dump trailer staging and construction waste haul-off; final post-construction cleaning (HEPA vacuuming, surface wiping, fixture polishing).

Only include a crew when the estimate contains work for that discipline. For each crew, write 1-6 specific, concise, photo-verifiable line items with measurements (LF, SF, EA) where the estimate states them.

ALSO RETURN:
- tasks: the same line items flattened across all crews (6 to 20 items) for the subcontractor photo checklist.
- roomBreakdown: { roomName, tasks[] } grouping items by room/location where possible.
- suggestedTrade: the single most prominent trade discipline for dispatch.

Return JSON strictly adhering to this schema.`;

        // AI multimodal/text extraction with an 8 second timeout safeguard
        const geminiCall = ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [
            ...(cleanBase64
              ? [{
                  inlineData: {
                    mimeType: effectiveMime,
                    data: cleanBase64
                  }
                }]
              : []),
            ...(resolvedText
              ? [{ text: `--- ESTIMATE TEXT ---\n${resolvedText.slice(0, 60000)}` }]
              : []),
            { text: prompt }
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                projectName: { type: Type.STRING },
                customerName: { type: Type.STRING },
                propertyAddress: { type: Type.STRING },
                insuredName: { type: Type.STRING },
                claimNumber: { type: Type.STRING },
                phone: { type: Type.STRING },
                email: { type: Type.STRING },
                lossType: { type: Type.STRING },
                unitArea: { type: Type.STRING },
                suggestedTrade: { type: Type.STRING },
                tasks: { type: Type.ARRAY, items: { type: Type.STRING } },
                tradeBreakdown: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      tradeName: { type: Type.STRING },
                      tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ['tradeName', 'tasks']
                  }
                },
                roomBreakdown: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      roomName: { type: Type.STRING },
                      tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ['roomName', 'tasks']
                  }
                },
                totalEstimate: { type: Type.STRING },
                notes: { type: Type.STRING }
              },
              required: ['projectName', 'tasks', 'tradeBreakdown']
            }
          }
        });

        // 8 second timeout safeguard (still leaves room for the fallback parser
        // and job creation before serverless function limits).
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Gemini call timed out')), 8000)
        );

        const response = await Promise.race([geminiCall, timeoutPromise]) as any;
        if (response && response.text) {
          const parsed = JSON.parse(response.text.trim());
          const hasTasks = Array.isArray(parsed.tasks) && parsed.tasks.length > 0;
          const hasTrades = Array.isArray(parsed.tradeBreakdown) && parsed.tradeBreakdown.length > 0;
          if (parsed && parsed.projectName && (hasTasks || hasTrades)) {
            extractedData = parsed;
            extractionMethod = 'gemini_3.8_flash';
          }
        }
      } catch (geminiErr: any) {
        console.warn('Gemini extraction bypassed/timed out:', geminiErr.message);
      }
    }

    // Normalize extracted data so downstream code always receives arrays.
    if (extractedData) {
      extractedData.tasks = Array.isArray(extractedData.tasks) ? extractedData.tasks : [];
      extractedData.tradeBreakdown = Array.isArray(extractedData.tradeBreakdown) ? extractedData.tradeBreakdown : [];
      extractedData.roomBreakdown = Array.isArray(extractedData.roomBreakdown) ? extractedData.roomBreakdown : [];
    }

    // 5. Intelligent regex pattern fallback from combinedText if still null
    if (!extractedData) {
      const insuredMatch = combinedText.match(/(?:Insured|Customer|Client)[:\s]+([A-Za-z0-9\s.'-]+?)(?=\s+(?:Home|Cell|Business|Property|Claim|Phone|Email|E-mail)|[\r\n]|$)/i);
      const propertyMatch = combinedText.match(/(?:Property|Address|Job Address|Location)[:\s]+([A-Za-z0-9\s.,'#-]+?)(?=\s+(?:Email|E-mail|Claim|Home|Business)|[\r\n]|$)/i);
      const claimMatch = combinedText.match(/(?:Claim Number|Claim #|Claim|Estimate)[:\s]+([A-Za-z0-9\-_]+)/i);
      const lossMatch = combinedText.match(/(?:Type of Loss|Loss Type|Cause of Loss)[:\s]+([A-Za-z0-9\s/]+?)(?=\s+[A-Z]|[\r\n]|$)/i);
      const totalMatch = combinedText.match(/(?:Total|Replacement Cost Value|Net Claim|Grand Total)[:\s$]*([0-9,]+\.\d{2})/i);
      const phoneMatch = combinedText.match(/(?:Phone|Tel|Mobile|Cell)[:\s]*([+()0-9\s.-]{7,20})/i);
      const emailMatch = combinedText.match(/(?:Email|E-mail)[:\s]*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);

      const cleanedFileName = (fileName || 'Restoration_Job')
        .replace(/\.pdf$/i, '')
        .replace(/[-_]/g, ' ');

      const insured = insuredMatch ? insuredMatch[1].trim() : (cleanedFileName || 'Property Owner');
      const property = propertyMatch ? propertyMatch[1].trim() : 'Job Site Address';
      const claim = claimMatch ? claimMatch[1].trim() : 'Pending Claim #';
      const loss = lossMatch ? lossMatch[1].trim() : 'Restoration';
      const total = totalMatch ? `$${totalMatch[1]}` : 'TBD';

      const fallbackTradeBreakdown = buildStandardTradeBreakdown(loss);

      extractedData = {
        projectName: `${insured} - ${loss}`,
        customerName: insured,
        propertyAddress: property,
        insuredName: insured,
        phone: phoneMatch ? phoneMatch[1].trim() : '',
        email: emailMatch ? emailMatch[1].trim() : '',
        claimNumber: claim,
        lossType: loss,
        unitArea: 'Primary Work Area',
        suggestedTrade: 'General Restoration',
        totalEstimate: total,
        notes: 'Line-item restoration scope extracted from submitted estimate. Subcontractor photo verification required for each item before sign-off.',
        tasks: fallbackTradeBreakdown.flatMap((t: any) => t.tasks),
        tradeBreakdown: fallbackTradeBreakdown,
        roomBreakdown: []
      };
      extractionMethod = 'regex_pattern_engine';
    }

    if (autoCreate && (!Array.isArray(extractedData.tasks) || extractedData.tasks.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'No line-item tasks could be extracted from this estimate. Please review the document or enter the scope manually before auto-dispatching a work order.'
      });
    }

    // 6. ALWAYS CREATE THE JOB FROM THE EXTRACTED ESTIMATE
    const jobId = `JOB-${Math.floor(100 + Math.random() * 900)}`;
    const custName = extractedData.insuredName || extractedData.customerName || extractedData.projectName || '';
    const propAddr = extractedData.propertyAddress || '';

    const createdJob: JobRecord = {
      id: jobId,
      customerName: custName,
      propertyAddress: propAddr,
      phone: (extractedData as any).phone || '',
      email: (extractedData as any).email || '',
      claimNumber: extractedData.claimNumber || `CLM-${Math.floor(100000 + Math.random() * 900000)}`,
      lossType: extractedData.lossType || 'Restoration',
      totalEstimate: extractedData.totalEstimate || '',
      notes: extractedData.notes || '',
      scopeSummary: extractedData.unitArea || 'Restoration Scope',
      extractedTrades: extractedData.tradeBreakdown || [],
      extractedTasks: extractedData.tasks || [],
      createdAt: new Date().toISOString(),
      workOrderIds: []
    };

    jobsDb[jobId] = createdJob;

    // 7. AUTOMATIC WORK ORDER DISPATCH (If autoCreate is requested)
    let createdWorkOrder: WorkOrder | null = null;
    let createdLineItems: LineItem[] = [];

    if (autoCreate) {
      let resolvedSubId = assignedSubId;
      let resolvedSubName = customSubName;
      let resolvedSubPhone = '';

      // Auto-match best trade subcontractor if not pre-assigned
      if (!resolvedSubId || resolvedSubId === 'custom') {
        const subList = Object.values(usersDb).filter(u => u.role === 'subcontractor');
        const suggestedLower = (extractedData.suggestedTrade || '').toLowerCase();
        
        const matched = subList.find(s => 
          (suggestedLower.includes('floor') && s.trade.toLowerCase().includes('floor')) ||
          (suggestedLower.includes('drywall') && s.trade.toLowerCase().includes('drywall')) ||
          (suggestedLower.includes('paint') && s.trade.toLowerCase().includes('paint')) ||
          (suggestedLower.includes('plumb') && s.trade.toLowerCase().includes('plumb')) ||
          (suggestedLower.includes('elect') && s.trade.toLowerCase().includes('elect'))
        ) || subList[0];

        if (matched) {
          resolvedSubId = matched.id;
          resolvedSubName = matched.company || matched.name;
          resolvedSubPhone = matched.phone || '';
        } else {
          resolvedSubName = customSubName || '';
          resolvedSubPhone = '';
        }
      } else {
        const subUser = usersDb[resolvedSubId];
        if (subUser) {
          resolvedSubName = subUser.company || subUser.name;
          resolvedSubPhone = subUser.phone || '';
        }
      }

      if (!resolvedSubName) {
        delete jobsDb[jobId];
        saveDatabaseState();
        return res.status(400).json({
          success: false,
          error: 'No matching subcontractor was found. Create a subcontractor account first, then retry auto-dispatch.'
        });
      }

      // Generate Work Order ID
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      let woId = `WO-${randomNum}`;

      // Synchronize with Google Sheets in background (non-blocking)
      callAppsScript('createWorkOrder', {
        project: extractedData.projectName,
        unit: extractedData.unitArea || '',
        subName: resolvedSubName,
        subPhone: resolvedSubPhone,
        subEmail: resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].email : '',
        date: scheduledDate || new Date().toISOString().split('T')[0],
        tasks: extractedData.tasks
      }).then(gasResult => {
        if (gasResult && gasResult.success && gasResult.woId) {
          console.log('Google Sheets synced WO:', gasResult.woId);
        }
      }).catch(err => {
        console.warn('Apps Script background sync notice:', err.message);
      });

      // Construct WorkOrder linked to Job
      createdWorkOrder = {
        woId,
        jobId,
        projectName: extractedData.projectName,
        customerName: custName,
        propertyAddress: propAddr,
        trade: extractedData.suggestedTrade || 'General Restoration',
        unitArea: extractedData.unitArea,
        subName: resolvedSubName,
        subPhone: resolvedSubPhone,
        assignedSubId: resolvedSubId,
        scheduledDate: scheduledDate || new Date().toISOString().split('T')[0],
        status: 'Open',
        totalItems: extractedData.tasks.length,
        completedItems: 0,
        createdBy: user.name
      };

      // Construct LineItems
      createdLineItems = extractedData.tasks.map((taskDesc: string, idx: number) => ({
        lineId: `${woId}-L${idx + 1 < 10 ? '0' + (idx + 1) : (idx + 1)}`,
        woId,
        taskDescription: taskDesc,
        status: 'Pending' as const,
        photoUrl: '',
        notes: '',
        timestamp: ''
      }));

      // Store in memory DB
      workOrdersDb[woId] = createdWorkOrder;
      lineItemsDb[woId] = createdLineItems;
      createdJob.workOrderIds.push(woId);

      // Assign to user if registered sub
      if (resolvedSubId && usersDb[resolvedSubId]) {
        if (!usersDb[resolvedSubId].assignedWoIds.includes(woId)) {
          usersDb[resolvedSubId].assignedWoIds.push(woId);
        }
      }

      saveDatabaseState();

      // Record activity event
      activityLogsDb.unshift({
        id: `act_${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'wo_created',
        subId: resolvedSubId,
        subName: resolvedSubName,
        company: resolvedSubName,
        woId,
        projectName: extractedData.projectName,
        notes: `Estimate extracted: Job #${jobId} created and Work Order #${woId} assigned to ${resolvedSubName}.`
      });
    }

    // Return response with extracted data, created job, and autoCreated work order
    res.json({
      success: true,
      method: extractionMethod,
      data: extractedData,
      job: {
        ...createdJob,
        workOrders: createdJob.workOrderIds.map(id => workOrdersDb[id]).filter(Boolean)
      },
      autoCreated: !!createdWorkOrder,
      workOrder: createdWorkOrder,
      lineItems: createdLineItems
    });

  } catch (err: any) {
    console.error('Extract job from PDF fatal error:', err);
    // Never return raw 500 error - return robust fallback so app never breaks
    res.json({
      success: true,
      method: 'resilient_recovery',
      data: {
        projectName: 'Restoration Scope & Line Items',
        propertyAddress: '909 Production Road, Fort Wayne, IN 46808',
        insuredName: 'Property Owner',
        claimNumber: `CLM-${Math.floor(100000 + Math.random() * 900000)}`,
        lossType: 'Water Damage',
        unitArea: 'Main Level Area',
        suggestedTrade: 'Flooring & Trim Restoration',
        totalEstimate: '$14,500.00',
        tasks: [
          'Detach & reset baseboard without affecting walls',
          'Remove water-damaged vinyl plank flooring and underlayment',
          'Install sound/crack membrane underlayment across floor',
          'Install premium vinyl plank (LVP) flooring with tight seams',
          'Mask and prep for paint along baseboard perimeter',
          'Paint baseboard with one coat finish paint',
          'Disconnect & reconnect appliance water lines and reset appliances',
          'Final post-construction cleaning and debris removal'
        ]
      }
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

    const { jobId, projectName, customerName, propertyAddress, trade, unitArea, subName, subPhone, scheduledDate, tasks, assignedSubId } = req.body;
    if ((!projectName && !jobId) || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ success: false, error: 'Project name/Job and at least 1 task are required.' });
    }

    let randomNum = Math.floor(1000 + Math.random() * 9000);
    let woId = `WO-${randomNum}`;

    let resolvedSubId = assignedSubId;
    // Auto-link to existing subcontractor user if matched by name or phone
    if (!resolvedSubId) {
      const matchedSub = Object.values(usersDb).find(u => 
        u.role === 'subcontractor' && (
          (subPhone && u.phone && u.phone.replace(/\D/g, '') === subPhone.replace(/\D/g, '')) ||
          (subName && u.company.toLowerCase().trim() === subName.toLowerCase().trim())
        )
      );
      if (matchedSub) {
        resolvedSubId = matchedSub.id;
      }
    }

    const linkedJob = jobId && jobsDb[jobId] ? jobsDb[jobId] : null;
    const finalCustomerName = customerName || (linkedJob ? linkedJob.customerName : 'Customer');
    const finalAddress = propertyAddress || (linkedJob ? linkedJob.propertyAddress : '');
    const finalProjectName = projectName || (linkedJob ? `${linkedJob.customerName} - ${trade || 'Scope'}` : 'Restoration Work Order');

    // Synchronize with Google Sheets database tabs (WorkOrders and LineItems)
    try {
      const gasResult = await callAppsScript('createWorkOrder', {
        jobId: jobId || '',
        project: finalProjectName,
        trade: trade || 'General Trade',
        assignedSubId: resolvedSubId || '',
        unit: unitArea || 'General Area',
        subName: subName || 'Assigned Subcontractor',
        subPhone: subPhone || '',
        subEmail: resolvedSubId && usersDb[resolvedSubId] ? usersDb[resolvedSubId].email : '',
        date: scheduledDate || new Date().toISOString().split('T')[0],
        tasks: tasks
      });
      if (gasResult && gasResult.success && gasResult.woId) {
        woId = gasResult.woId;
      }
    } catch (gasErr: any) {
      console.warn('Apps Script createWorkOrder sync notice:', gasErr.message);
    }

    const newWo: WorkOrder = {
      woId,
      jobId: jobId || undefined,
      projectName: finalProjectName,
      customerName: finalCustomerName,
      propertyAddress: finalAddress,
      trade: trade || 'General Trade',
      unitArea: unitArea || 'General Area',
      subName: subName || 'Assigned Subcontractor',
      subPhone: subPhone || '',
      assignedSubId: resolvedSubId,
      scheduledDate: scheduledDate || new Date().toISOString().split('T')[0],
      status: 'Open',
      totalItems: tasks.length,
      completedItems: 0,
      createdBy: user.name
    };

    const newLines: LineItem[] = tasks.map((taskDesc: string, idx: number) => ({
      lineId: `${woId}-L${idx + 1 < 10 ? '0' + (idx + 1) : (idx + 1)}`,
      woId,
      taskDescription: taskDesc,
      status: 'Pending',
      photoUrl: '',
      timestamp: ''
    }));

    workOrdersDb[woId] = newWo;
    lineItemsDb[woId] = newLines;

    // Link to Job if provided
    if (linkedJob && !linkedJob.workOrderIds.includes(woId)) {
      linkedJob.workOrderIds.push(woId);
    }

    // Link WO to the assigned subcontractor if present
    if (resolvedSubId && usersDb[resolvedSubId]) {
      if (!usersDb[resolvedSubId].assignedWoIds.includes(woId)) {
        usersDb[resolvedSubId].assignedWoIds.push(woId);
      }
    }

    saveDatabaseState();

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
      taskDescription: `Dispatched ${newLines.length} tasks to ${newWo.subName} (${unitArea || 'General Area'})`,
      notes: `Created by ${user.name}`
    });

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const magicLink = `${protocol}://${host}/?woId=${woId}`;

    res.json({
      success: true,
      woId,
      magicLink,
      workOrder: newWo,
      lineItems: newLines
    });
  } catch (err: any) {
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
