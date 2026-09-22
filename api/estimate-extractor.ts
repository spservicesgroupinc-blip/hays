/**
 * Estimate intelligence pipeline for Hays + Sons FieldProof.
 *
 * Responsibilities
 *  1. Real PDF text extraction (FlateDecode inflation, content-stream text
 *     operators, PDF string escapes and best-effort ToUnicode CMaps) instead of
 *     grepping raw latin1 bytes.
 *  2. Deterministic extraction of customer/job fields and scope line items with
 *     measured quantities, taken ONLY from the submitted document.
 *  3. Deterministic mapping of those real line items onto the seven Hays + Sons
 *     trade crews (no invented tasks).
 *  4. Optional Gemini enrichment that is strictly validated against the source
 *     document - anything the model returns that is not found in the document is
 *     discarded, so the pipeline can never fabricate scope.
 *
 * Nothing in this module invents demo data. When a document has no usable scope
 * the caller receives an empty task list plus actionable warnings.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export type EstimateSource = 'pdf' | 'text';

export interface ExtractedLineItem {
  description: string;
  quantity: string;
  unit: string;
  room: string;
  trade: string;
  /** Verb-first plain-English field instruction for the crew (no pricing, no codes). */
  instruction?: string;
}

export interface FieldWorkOrderRoom {
  roomName: string;
  instructions: string[];
}

/**
 * One field-ready work order section per trade crew, shaped around the five
 * sub-blocks a crew lead needs: scope summary, safety/containment protocols,
 * step-by-step instructions by room, material specs, and QC/punchlist checks.
 */
export interface FieldWorkOrderSection {
  tradeName: string;
  scopeSummary: string;
  safetyProtocols: string[];
  rooms: FieldWorkOrderRoom[];
  materials: string[];
  qualityChecks: string[];
  /** Credited / omitted scope the crew must NOT perform. */
  exclusions: string[];
}

export interface ExtractedTradeGroup {
  tradeName: string;
  tasks: string[];
}

export interface ExtractedRoomGroup {
  roomName: string;
  tasks: string[];
}

export interface DocumentStats {
  characters: number;
  pages: number;
  hasTextLayer: boolean;
  lookedLikeScan: boolean;
}

export interface EstimateExtraction {
  projectName: string;
  customerName: string;
  propertyAddress: string;
  phone: string;
  email: string;
  claimNumber: string;
  insuranceCarrier: string;
  adjusterName: string;
  lossType: string;
  dateOfLoss: string;
  unitArea: string;
  totalEstimate: string;
  notes: string;
  suggestedTrade: string;
  tasks: string[];
  lineItems: ExtractedLineItem[];
  tradeBreakdown: ExtractedTradeGroup[];
  roomBreakdown: ExtractedRoomGroup[];
  /** Trade-by-trade field package handed to the crews (financials/codes removed). */
  fieldPackage: FieldWorkOrderSection[];
  confidence: number;
  warnings: string[];
  extractionMethod: string;
  source: EstimateSource;
  sourceHash: string;
  documentStats: DocumentStats;
  demoTemplatesSuppressed: number;
}

export interface ExtractEstimateOptions {
  pdfBase64?: string;
  mimeType?: string;
  textSnippet?: string;
  fileName?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SEVEN STANDARD TRADE CREWS
// ---------------------------------------------------------------------------

export const SEVEN_CREWS = [
  'Contents Handling, Site Protection & Demolition Crew',
  'Plumbing & Mechanical Trade Crew',
  'Electrical Trade Crew',
  'Flooring & Underlayment Trade Crew',
  'Finish Carpentry, Doors & Cabinetry Crew',
  'Painting & Surface Finishing Crew',
  'Post-Job Cleanup & Debris Removal Crew'
] as const;

export const GENERAL_TRADE = 'General Restoration';

interface TradeRule {
  name: string;
  /** subject/material keywords - strong signal, weight 9 */
  subjects: string[];
  /** supporting/action keywords - weak signal, weight 3 */
  actions: string[];
}

/**
 * Ordered crew rules. Scoring (not first-match) decides the crew so that
 * "Remove & reset baseboard" lands on Finish Carpentry (baseboard) rather than
 * Demolition (remove).
 */
const TRADE_RULES: TradeRule[] = [
  {
    name: SEVEN_CREWS[0],
    subjects: ['content', 'contents', 'pack out', 'pack-out', 'packout', 'inventory', 'poly', 'plastic sheeting', 'zipper', 'containment', 'air scrubber', 'scrubber', 'negative air', 'hepa', 'debris', 'dumpster', 'dump trailer', 'floor protection', 'dust barrier', 'demo', 'demolition', 'tear out', 'tear-out', 'tearout', 'extraction', 'insulation', 'drywall removal', 'plaster', 'board up', 'board-up', 'boardup', 'tarp', 'shoring'],
    actions: ['remove', 'removal', 'detach', 'cut out', 'dispose', 'haul', 'protect', 'move', 'stage', 'mask off']
  },
  {
    name: SEVEN_CREWS[1],
    subjects: ['plumb', 'plumbing', 'water line', 'supply line', 'angle stop', 'faucet', 'sink', 'toilet', 'p-trap', 'ptrap', 'escutcheon', 'dishwasher', 'refrigerator', 'ice maker', 'washing machine', 'water heater', 'shut off valve', 'shutoff', 'valve', 'hvac', 'condensate', 'duct', 'mechanical', 'appliance'],
    actions: ['disconnect', 'reconnect', 'cap off', 'cap-off', 'reset', 'de-energize', 'reinstall']
  },
  {
    name: SEVEN_CREWS[2],
    subjects: ['electric', 'electrical', 'outlet', 'receptacle', 'gfci', 'switch plate', 'switch', 'junction box', 'breaker', 'electrical panel', 'recessed light', 'light fixture', 'lighting', 'ceiling fan', 'exhaust fan', 'romex', 'smoke detector', 'gfci outlet'],
    actions: ['rewire', 're-terminate', 'bond', 'ground']
  },
  {
    name: SEVEN_CREWS[3],
    subjects: ['floor', 'flooring', 'carpet', 'vinyl plank', 'vinyl', 'lvp', 'lvt', 'laminate', 'tile', 'ceramic', 'porcelain', 'hardwood', 'subfloor', 'underlayment', 'membrane', 'transition strip', 'base shoe', 'tack strip', 'carpet pad', 'grout', 'thinset', 'leveler', 'stair tread', 'cove base'],
    actions: ['install', 'lay', 'glue down', 'float', 'seam seal', 'seal']
  },
  {
    name: SEVEN_CREWS[4],
    subjects: ['baseboard', 'base board', 'casing', 'trim', 'crown molding', 'door', 'doors', 'door slab', 'door jamb', 'jamb', 'casing', 'hardware', 'bifold', 'shelving', 'closet rod', 'cabinet', 'cabinetry', 'cabinet door', 'countertop', 'counter top', 'vanity', 'toe kick', 'handrail', 'baluster', 'window sill', 'window casing', 'sidelite', 'stair', 'carpentry', 'carpenter', 'millwork', 'tablet', 'louver'],
    actions: ['hang', 'reset', 'reinstall', 'refinish', 'square', 'shim']
  },
  {
    name: SEVEN_CREWS[5],
    subjects: ['paint', 'painting', 'primer', 'prime', 'caulk', 'caulking', 'texture', 'drywall', 'sheetrock', 'gypsum', 'joint compound', 'mud', 'tape and bed', 'tape & bed', 'wall finish', 'ceiling finish', 'stain', 'urethane', 'lacquer', 'wallpaper', 'skim coat', 'orange peel', 'knockdown', 'popcorn ceiling', 'wall patch', 'wall'],
    actions: ['sand', 'patch', 'coat', 'spray', 'roll', 'brush', 'feather']
  },
  {
    name: SEVEN_CREWS[6],
    subjects: ['clean', 'cleaning', 'vacuum', 'hepa vacuum', 'wipe', 'mop', 'sanitize', 'disinfect', 'deodorize', 'deodorization', 'ozone', 'hydroxyl', 'fogging', 'final clean', 'post-construction clean', 'construction cleaning', 'dumpster', 'debris removal', 'haul off', 'haul-off', 'disposal'],
    actions: ['clean', 'remove debris', 'polish', 'dust']
  }
];

/** Lines that describe a real removal/tear-out of a building material belong to
 *  the demolition crew even though the material keyword points elsewhere. */
const DEMOLITION_VERBS = /^(remove|removal|demo|demolish|tear ?out|cut ?out|strip|pry|dispose of|haul off)\b/i;
/** Substrates that are torn out and rebuilt by different crews; a removal verb on
 *  one of these is unambiguously controlled demolition. */
const TEAR_OUT_MATERIALS = /(drywall|sheetrock|sheet rock|gypsum|plaster|lath|insulation|paneling|panelling|wallboard|wall board|subfloor|ceiling tile|acoustic ceiling)/i;
/** Finished goods a crew may remove and reinstall itself - these only get a soft
 *  demolition nudge so "Remove & reset baseboard" still lands on carpentry. */
const BUILDING_MATERIALS = /(floor|flooring|carpet|tile|vinyl|laminate|hardwood|drywall|sheetrock|plaster|trim|baseboard|casing|door|cabinet|vanity|countertop|insulation|panel)/i;

// ---------------------------------------------------------------------------
// PDF TEXT EXTRACTION
// ---------------------------------------------------------------------------

export interface PdfTextResult {
  text: string;
  pages: number;
  hasTextLayer: boolean;
  lookedLikeScan: boolean;
  warnings: string[];
}

const MAX_STREAMS = 600;
const MAX_TEXT_CHARS = 400_000;

function countPdfPages(raw: string): number {
  const pageRefs = raw.match(/\/Type\s*\/Page(?![s])/g);
  return Math.max(pageRefs ? pageRefs.length : 0, 1);
}

function findDictEnd(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length - 1; i++) {
    if (source[i] === '<' && source[i + 1] === '<') {
      depth++;
      i++;
    } else if (source[i] === '>' && source[i + 1] === '>') {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** Locate the object dictionary that owns the `stream` keyword at `index`. */
function findOwningDict(raw: string, index: number): string {
  const windowStart = Math.max(0, index - 6000);
  const tail = raw.slice(windowStart, index);
  const candidates: number[] = [];
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i] === '<' && tail[i + 1] === '<') candidates.push(i);
  }
  for (let c = candidates.length - 1; c >= 0; c--) {
    const start = candidates[c];
    const end = findDictEnd(tail, start + 2);
    if (end !== -1 && tail.slice(end + 2).trim() === '') {
      return tail.slice(start, end + 2);
    }
  }
  return '';
}

function decodeAscii85(chunk: Buffer): Buffer | null {
  try {
    const src = chunk.toString('latin1').replace(/\s+/g, '').replace(/~>$/, '');
    const out: number[] = [];
    let tuple = 0;
    let count = 0;
    for (const ch of src) {
      if (ch === 'z' && count === 0) {
        out.push(0, 0, 0, 0);
        continue;
      }
      const code = ch.charCodeAt(0) - 33;
      if (code < 0 || code > 84) return null;
      tuple = tuple * 85 + code;
      count++;
      if (count === 5) {
        out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
        tuple = 0;
        count = 0;
      }
    }
    if (count > 0) {
      for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
    }
    return Buffer.from(out);
  } catch {
    return null;
  }
}

function decodeStreamChunk(dict: string, chunk: Buffer): Buffer | null {
  const filterMatch = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/);
  const filters = filterMatch ? filterMatch[1] : '';
  const hasFilter = (name: string) => filters.includes(name);

  if (hasFilter('FlateDecode')) {
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        return inflate(chunk);
      } catch {
        /* try next strategy */
      }
    }
    return null;
  }
  if (hasFilter('ASCIIHexDecode')) {
    const hex = chunk.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  }
  if (hasFilter('ASCII85Decode')) {
    return decodeAscii85(chunk);
  }
  if (hasFilter('LZWDecode') || hasFilter('DCTDecode') || hasFilter('JPXDecode') || hasFilter('CCITTFaxDecode')) {
    // Compression the pipeline cannot read (LZW / embedded images).
    return null;
  }
  if (/\/Subtype\s*\/Image/.test(dict)) return null;
  return chunk;
}

function decodePdfLiteral(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case 'n':
        out += '\n';
        i++;
        break;
      case 'r':
        out += '\r';
        i++;
        break;
      case 't':
        out += '\t';
        i++;
        break;
      case 'b':
        out += '\b';
        i++;
        break;
      case 'f':
        out += '\f';
        i++;
        break;
      case '(':
      case ')':
      case '\\':
        out += next;
        i++;
        break;
      case '\r':
      case '\n':
        i++;
        break;
      default: {
        const octal = body.slice(i + 1).match(/^[0-7]{1,3}/);
        if (octal) {
          out += String.fromCharCode(parseInt(octal[0], 8));
          i += octal[0].length;
        } else {
          out += next ?? '';
          i++;
        }
      }
    }
  }
  return out;
}

function decodePdfHex(body: string): string {
  const hex = body.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.slice(i, i + 2);
    const code = parseInt(pair.length === 1 ? `${pair}0` : pair, 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

// NOTE: the operator alternatives must not be wrapped in a trailing \b - a word
// boundary can never follow the non-word characters in T* / ' / ", so those tokens
// would silently never match (which collapsed entire PDF pages into one line).
const CONTENT_TOKEN_RE = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\b(?:BT|ET|TJ|Tj|Td|TD|T\*|Tm|Tf|Tl|Tc|Tw|Ts)(?![A-Za-z0-9])|['"]|-?\d+(?:\.\d+)?/g;

/**
 * Pull the visible text out of an uncompressed PDF content stream.
 *
 * Line breaks are inferred from text-positioning operators rather than assumed:
 * a vertical jump (Td/TD with a non-zero ty, T*, Tm with a new Y, ET) starts a new
 * line, while a pure horizontal move stays on the same line. Without this the whole
 * page collapses into one unusable string and no scope line can be parsed.
 */
function extractTextFromContentStream(content: string): string {
  let text = '';
  let pending: string[] = [];
  let arrayPieces: string[] = [];
  let arrayDepth = 0;
  let args: number[] = [];
  let pendingBreak: 'newline' | 'space' | null = null;
  let lastY: number | null = null;

  const applyBreak = () => {
    if (!pendingBreak) return;
    if (text.length === 0) {
      pendingBreak = null;
      return;
    }
    if (pendingBreak === 'newline') {
      if (!text.endsWith('\n')) text += '\n';
    } else if (!/[\s\n]$/.test(text)) {
      text += ' ';
    }
    pendingBreak = null;
  };

  const flush = (value: string) => {
    if (!value) return;
    applyBreak();
    text += value;
  };

  const showText = (extraBreak: 'newline' | 'space' | null) => {
    // The break recorded by the *preceding* positioning operator closes the text
    // that is being shown now; extraBreak opens a new line after this text.
    flush(pending.join(''));
    pending = [];
    args = [];
    if (extraBreak) pendingBreak = extraBreak;
  };

  CONTENT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = CONTENT_TOKEN_RE.exec(content);
  while (match) {
    const token = match[0];
    if (token === '[') {
      arrayDepth++;
      arrayPieces = [];
    } else if (token === ']') {
      arrayDepth = Math.max(0, arrayDepth - 1);
      if (arrayDepth === 0 && arrayPieces.length > 0) {
        pending.push(arrayPieces.join(''));
        arrayPieces = [];
      }
    } else if (token.startsWith('(')) {
      const decoded = decodePdfLiteral(token.slice(1, -1));
      if (arrayDepth > 0) arrayPieces.push(decoded);
      else pending.push(decoded);
    } else if (token.startsWith('<')) {
      const decoded = decodePdfHex(token.slice(1, -1));
      if (arrayDepth > 0) arrayPieces.push(decoded);
      else pending.push(decoded);
    } else if (/^-?\d/.test(token)) {
      if (arrayDepth > 0) {
        const kern = Number(token);
        if (kern <= -140) arrayPieces.push(' ');
      } else {
        args.push(Number(token));
        if (args.length > 8) args = args.slice(-8);
      }
    } else if (token === 'Tj' || token === 'TJ') {
      showText(null);
    } else if (token === "'" || token === '"') {
      showText('newline');
    } else if (token === 'Td' || token === 'TD') {
      const ty = args.length > 0 ? args[args.length - 1] : 0;
      lastY = (lastY ?? 0) + ty;
      pendingBreak = ty !== 0 ? 'newline' : 'space';
      args = [];
    } else if (token === 'T*') {
      pendingBreak = 'newline';
      args = [];
    } else if (token === 'Tm') {
      const f = args.length >= 6 ? args[args.length - 1] : null;
      pendingBreak = f !== null && lastY !== null && Math.abs(f - lastY) > 0.5 ? 'newline' : 'space';
      if (f !== null) lastY = f;
      args = [];
    } else if (token === 'ET') {
      pendingBreak = 'newline';
      args = [];
    } else if (token === 'BT') {
      if (text.trim()) pendingBreak = 'newline';
      lastY = null;
      args = [];
    }
    if (text.length > MAX_TEXT_CHARS) break;
    match = CONTENT_TOKEN_RE.exec(content);
  }
  flush(pending.join(''));
  return text;
}

/** Collect every ToUnicode mapping we can find so symbol-encoded PDFs still read. */
function collectCMaps(decodedStreams: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const stream of decodedStreams) {
    if (!stream.includes('beginbfchar') && !stream.includes('beginbfrange')) continue;

    const charBlockRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let block: RegExpExecArray | null;
    while ((block = charBlockRe.exec(stream))) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
      let pair: RegExpExecArray | null;
      while ((pair = pairRe.exec(block[1]))) {
        const code = parseInt(pair[1], 16);
        if (!Number.isNaN(code) && pair[2]) map.set(code, hexToUnicode(pair[2]));
      }
    }

    const rangeBlockRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((block = rangeBlockRe.exec(stream))) {
      const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[\s\S]*?\])/g;
      let range: RegExpExecArray | null;
      while ((range = rangeRe.exec(block[1]))) {
        const start = parseInt(range[1], 16);
        const end = parseInt(range[2], 16);
        if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
        if (range[3].startsWith('[')) {
          const items = range[3].match(/<[0-9A-Fa-f]*>/g) || [];
          items.forEach((item, idx) => {
            const code = start + idx;
            if (code <= end) map.set(code, hexToUnicode(item.slice(1, -1)));
          });
        } else {
          const target = range[3].slice(1, -1);
          const base = parseInt(target || '0', 16);
          for (let code = start; code <= end; code++) {
            map.set(code, String.fromCharCode(base + (code - start)));
          }
        }
      }
    }
  }
  return map;
}

function hexToUnicode(hex: string): string {
  let out = '';
  for (let i = 0; i < hex.length; i += 4) {
    const chunk = hex.slice(i, i + 4).padEnd(4, '0');
    const code = parseInt(chunk, 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

function applyCMap(text: string, map: Map<number, string>): string {
  if (map.size === 0) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const mapped = map.get(code);
    out += mapped && mapped.length > 0 ? mapped : text[i];
  }
  return out;
}

function printableRatio(text: string): number {
  if (!text) return 0;
  const printable = text.replace(/[\p{C}\uFFFD]/gu, '').length;
  return printable / text.length;
}

export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.slice(0, 1024).toString('latin1').includes('%PDF');
}

/**
 * Extract the text layer from a PDF buffer.
 * Handles uncompressed streams and FlateDecode/ASCIIHex/ASCII85 streams, PDF
 * string escapes, TJ kerning arrays and ToUnicode CMaps. Returns
 * `hasTextLayer === false` for scanned/image-only PDFs so callers can ask the
 * user for pasted text instead of pretending extraction succeeded.
 */
export function extractPdfText(buffer: Buffer): PdfTextResult {
  const warnings: string[] = [];
  const raw = buffer.toString('latin1');
  const pages = countPdfPages(raw);

  if (!isPdfBuffer(buffer)) {
    return {
      text: '',
      pages: 1,
      hasTextLayer: false,
      lookedLikeScan: false,
      warnings: ['The uploaded file is not a valid PDF. Paste the estimate text or upload a PDF export.']
    };
  }

  const decodedStreams: string[] = [];
  const pageTextChunks: string[] = [];

  const streamKeyword = Buffer.from('stream', 'latin1');
  const endKeyword = Buffer.from('endstream', 'latin1');
  let cursor = 0;
  let processed = 0;

  while (processed < MAX_STREAMS) {
    const streamIndex = buffer.indexOf(streamKeyword, cursor);
    if (streamIndex === -1) break;

    let dataStart = streamIndex + streamKeyword.length;
    const trailing = buffer.slice(dataStart, dataStart + 2).toString('latin1');
    if (trailing.startsWith('\r\n')) dataStart += 2;
    else if (trailing.startsWith('\n') || trailing.startsWith('\r')) dataStart += 1;

    const dataEnd = buffer.indexOf(endKeyword, dataStart);
    if (dataEnd === -1) break;

    const dict = findOwningDict(raw, streamIndex);
    const chunk = buffer.slice(dataStart, dataEnd);
    const decoded = decodeStreamChunk(dict, chunk);

    if (decoded) {
      const decodedText = decoded.toString('latin1');
      decodedStreams.push(decodedText);
      const looksLikeContent = /(?:^|[\s>])(?:BT|Tj|TJ|Td)\b/.test(decodedText);
      if (looksLikeContent) {
        pageTextChunks.push(extractTextFromContentStream(decodedText));
      }
    }

    processed++;
    cursor = dataEnd + endKeyword.length;
  }

  const cmap = collectCMaps(decodedStreams);
  let text = pageTextChunks
    .map((chunk) => (printableRatio(chunk) < 0.5 ? applyCMap(chunk, cmap) : chunk))
    .join('\n');

  text = text.replace(/\u0000/g, '').replace(/[ \t]{3,}/g, '  ').trim();

  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  const printable = text.split('').filter((ch) => !/[\p{C}\uFFFD]/u.test(ch)).length;
  const hasTextLayer = printable >= Math.max(25, pages * 25);
  const looksLikeScan = !hasTextLayer && /\/Subtype\s*\/Image/.test(raw);

  if (!hasTextLayer) {
    warnings.push(
      looksLikeScan
        ? 'This PDF is a scanned image with no text layer. Paste the estimate text (or upload the digital PDF export) so the scope can be read.'
        : 'No readable text was found in this PDF. Paste the estimate text so the scope can be read.'
    );
  }

  return { text, pages, hasTextLayer, lookedLikeScan: looksLikeScan, warnings };
}

// ---------------------------------------------------------------------------
// TEXT NORMALISATION
// ---------------------------------------------------------------------------

const NOISE_LINE_PATTERNS: RegExp[] = [
  /^page\s+\d+\s*(of|\/)\s*\d+$/i,
  /^\d+\s*\/\s*\d+$/,
  /^[-–—_=*.\s]+$/,
  /^(xactimate|symbility|corelogic|msb|axiom|contractor connection)\b/i,
  /^https?:\/\/\S+$/i,
  /^(phone|fax)\s*[:#]?\s*[\d()\-.\s]+$/i,
  /^printed\s+(on|by)\b/i,
  /^(estimate|invoice|scope of work)\s*#?\s*[\w-]*$/i,
  /^(licen[cs]e|permit)\s*#?\s*[\w-]+$/i,
  /^(continued|cont'd)\b/i
];

export function normalizeDocumentText(raw: string): string {
  if (!raw) return '';
  const withBreaks = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');

  const lines = withBreaks
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, '  ').trim())
    .filter((line) => line.length > 0 && !NOISE_LINE_PATTERNS.some((re) => re.test(line)));

  // Collapse repeated identical lines (common with PDF page furniture/overlays).
  const deduped: string[] = [];
  for (const line of lines) {
    const last = deduped[deduped.length - 1];
    if (last && last.toLowerCase() === line.toLowerCase()) continue;
    deduped.push(line);
  }
  return deduped.join('\n');
}

// ---------------------------------------------------------------------------
// FIELD EXTRACTION HELPERS
// ---------------------------------------------------------------------------

const STREET_SUFFIX = '(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|circle|cir|place|pl|way|terrace|ter|trail|trl|highway|hwy|parkway|pkwy|loop|pass|run|row|square|sq|cove|path|pike|crossing|xing|point|pt|ridge|view|grove|glen|landing|walk|bend|hollow)';

const ADDRESS_RE = new RegExp(`\\d{1,6}\\s+[A-Za-z0-9.'\\- ]{2,45}\\b${STREET_SUFFIX}\\b\\.?(?:\\s*(?:,|\\s)\\s*(?:apt|unit|ste|suite|#)\\s*[A-Za-z0-9-]+)?(?:\\s*,\\s*[A-Za-z .'\\-]{2,30})?(?:\\s*,\\s*[A-Z]{2}\\s*\\d{5}(?:-\\d{4})?)?`, 'i');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d{1,7}(?:\.\d{2})?)/;

const COMPANY_RE = /\b(inc|llc|l\.l\.c|co|corp|company|insurance|insurers?|mutual|assurance|group|agency|adjusters?|services?|restoration|construction|properties|holdings|bank|mortgage)\b/i;

function normalizePhone(value: string): string {
  const digits = (value.match(/\d/g) || []).join('');
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return '';
}

function isPlausiblePhone(value: string): boolean {
  const digits = (value.match(/\d/g) || []).join('');
  if (digits.length < 10 || digits.length > 11) return false;
  if (/^(0+|1+|9+)$/.test(digits)) return false;
  const area = digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3);
  return area[0] !== '0' && area[0] !== '1';
}

function isPlausiblePersonName(value: string): boolean {
  const cleaned = value.replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length < 3 || cleaned.length > 60) return false;
  if (/\d/.test(cleaned)) return false;
  if (EMAIL_RE.test(cleaned) || COMPANY_RE.test(cleaned)) return false;
  if (/[:;]/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const alphaWords = words.filter((word) => /^[A-Za-z'.-]+$/.test(word));
  return alphaWords.length === words.length;
}

function isPlausibleAddress(value: string): boolean {
  const cleaned = value.trim();
  if (cleaned.length < 6 || cleaned.length > 120) return false;
  if (COMPANY_RE.test(cleaned) && !/\d/.test(cleaned)) return false;
  return /\d/.test(cleaned) || new RegExp(`\\b${STREET_SUFFIX}\\b`, 'i').test(cleaned);
}

function titleCaseName(value: string): string {
  const cleaned = value.replace(/\s{2,}/g, ' ').replace(/[.,;:]$/, '').trim();
  if (!cleaned) return '';
  if (cleaned === cleaned.toUpperCase()) {
    return cleaned
      .toLowerCase()
      .split(/(\s|-)/)
      .map((piece) => (/^[a-z]/.test(piece) ? piece.charAt(0).toUpperCase() + piece.slice(1) : piece))
      .join('');
  }
  return cleaned;
}

function labeledValue(lines: string[], labels: string[], accept: (value: string) => boolean): string {
  for (const label of labels) {
    const re = new RegExp(`^${label}\\s*(?:name|number|no\\.?|#)?\\s*[:\\-]?\\s*(.+)$`, 'i');
    for (const line of lines) {
      const match = line.match(re);
      if (match && match[1]) {
        const candidate = match[1]
          .replace(/\s*(?:phone|tel|cell|home|business|email|e-mail|claim|policy)\s*[:#].*$/i, '')
          .trim();
        if (accept(candidate)) return candidate;
      }
    }
  }
  return '';
}

function findAddress(text: string, lines: string[]): string {
  const labeled = labeledValue(lines, ['property address', 'loss address', 'job address', 'site address', 'service address', 'address of loss', 'property', 'address'], isPlausibleAddress);
  if (labeled) return titleCaseName(labeled).replace(/\s{2,}/g, ' ');

  const matches = text.match(new RegExp(ADDRESS_RE.source, 'gi')) || [];
  if (matches.length === 0) return '';
  const scored = matches
    .map((candidate) => candidate.replace(/\s{2,}/g, ' ').trim())
    .sort((a, b) => {
      const score = (value: string) => (/,[A-Z]{2}\s*\d{5}/.test(value) ? 2 : /\d{5}/.test(value) ? 1 : 0) * 100 + value.length;
      return score(b) - score(a);
    });
  return titleCaseName(scored[0]);
}

function findPhone(lines: string[], text: string): string {
  const labeled = labeledValue(lines, ['phone', 'cell', 'mobile', 'telephone', 'tel', 'contact phone'], (value) => isPlausiblePhone(value));
  if (labeled) return normalizePhone(labeled);

  const contextRe = /(?:phone|cell|mobile|tel|contact)\D{0,12}((?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/i;
  const contextMatch = text.match(contextRe);
  if (contextMatch && isPlausiblePhone(contextMatch[1])) return normalizePhone(contextMatch[1]);

  const generic = text.match(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/);
  if (generic) {
    const digits = `${generic[1]}${generic[2]}${generic[3]}`;
    if (isPlausiblePhone(digits)) return normalizePhone(digits);
  }
  return '';
}

function findEmail(text: string): string {
  const match = text.match(EMAIL_RE);
  return match ? match[0].replace(/[.,;]$/, '') : '';
}

function findClaimNumber(lines: string[], text: string): string {
  const labeled = labeledValue(lines, ['claim number', 'claim no', 'claim #', 'claim', 'file number', 'file no', 'file #', 'reference number', 'reference', 'ref'], (value) => {
    const cleaned = value.replace(/[^A-Za-z0-9\-/_]/g, '');
    if (cleaned.length < 4 || cleaned.length > 30) return false;
    if (!/\d/.test(cleaned)) return false;
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(cleaned)) return false;
    return true;
  });
  if (labeled) return labeled.replace(/[^A-Za-z0-9\-/_]/g, '').toUpperCase();

  const inline = text.match(/(?:claim|file|ref(?:erence)?)\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z]{0,4}[-\s]?\d{4,}[A-Z0-9-]*)/i);
  if (inline && inline[1]) {
    const cleaned = inline[1].replace(/[^A-Za-z0-9-]/g, '');
    if (cleaned.length >= 4) return cleaned.toUpperCase();
  }
  return '';
}

const CARRIER_HINTS = /\b(state farm|allstate|farmers|nationwide|travelers|usaa|liberty mutual|erie insurance|auto-owners|auto owners|chubb|hartford|safeco|american family|progressive|homesite|mercury|metlife|lemonade|openly|hippo|kin insurance|cincinnati|westfield|grange|foremost|shelter|country financial|amica|csaa|aaa|the general|root insurance|assurant|sedgwick|crawford|alacrity|pilot|custard|ccmsi|gallagher|tower hill|bristol west|arvella|bravado)\b/i;

function findCarrier(lines: string[], text: string): string {
  const labeled = labeledValue(lines, ['insurance company', 'insurance carrier', 'carrier', 'insured by', 'insurance'], (value) => {
    const cleaned = value.trim();
    return cleaned.length >= 3 && cleaned.length <= 60 && !/\d{4,}/.test(cleaned);
  });
  if (labeled) return titleCaseName(labeled);

  for (const line of lines) {
    if (CARRIER_HINTS.test(line)) {
      const cleaned = line
        .replace(/^(?:insurance\s+(?:company|carrier)|carrier|insured\s+by)\s*[:\-]?\s*/i, '')
        .replace(/\b(?:claim|policy|adjuster|phone|email|fax)\b.*$/i, '')
        .trim();
      if (cleaned.length >= 3) return titleCaseName(cleaned);
    }
  }
  const match = text.match(CARRIER_HINTS);
  return match ? titleCaseName(match[0]) : '';
}

function findAdjuster(lines: string[], text: string): string {
  const labeled = labeledValue(lines, ['adjuster', 'adjuster name', 'claims adjuster', 'estimator', 'inspector', 'loss consultant'], isPlausiblePersonName);
  if (labeled) return titleCaseName(labeled);

  const inline = text.match(/(?:adjuster|estimator)\s*(?:name)?\s*[:\-]\s*([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,2})/);
  return inline && isPlausiblePersonName(inline[1]) ? titleCaseName(inline[1]) : '';
}

function parseIsoDate(raw: string): string {
  const cleaned = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  const monthNames: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };
  let year = 0;
  let month = 0;
  let day = 0;

  let match = cleaned.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  if (!year) {
    match = cleaned.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (match) {
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
      if (month > 12 && day <= 12) [month, day] = [day, month];
    }
  }
  if (!year) {
    match = cleaned.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (match) {
      month = monthNames[match[1].slice(0, 4).toLowerCase()] || monthNames[match[1].slice(0, 3).toLowerCase()] || 0;
      day = Number(match[2]);
      year = Number(match[3]);
    }
  }
  if (!year) {
    match = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (match) {
      day = Number(match[1]);
      month = monthNames[match[2].slice(0, 3).toLowerCase()] || 0;
      year = Number(match[3]);
    }
  }

  if (!year || !month || !day) return '';
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function findDate(lines: string[], labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`^${label}\\s*[:\\-]?\\s*([0-9A-Za-z]{1,12}[\\/\\-. ][0-9A-Za-z]{1,9}[\\/\\-. ]?\\d{2,4})`, 'i');
    for (const line of lines) {
      const match = line.match(re);
      if (match) {
        const iso = parseIsoDate(match[1]);
        if (iso) return iso;
      }
    }
  }
  return '';
}

function findTotal(lines: string[], text: string): string {
  const candidates: number[] = [];
  const collect = (source: string, re: RegExp) => {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(source))) {
      const value = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(value) && value >= 100 && value <= 5_000_000) candidates.push(value);
    }
  };

  for (const line of lines) {
    if (/replacement cost|rcv|net claim|grand total|total estimate|total\b|insured loss|subtotal/i.test(line)) {
      collect(line, new RegExp(MONEY_RE.source, 'g'));
    }
  }
  if (candidates.length === 0) collect(text, new RegExp(MONEY_RE.source, 'g'));
  if (candidates.length === 0) return '';
  const best = Math.max(...candidates);
  return `$${best.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const LOSS_RULES: Array<{ label: string; keywords: RegExp }> = [
  { label: 'Fire & Smoke Damage', keywords: /\b(fire|smoke|soot|char|burn|arson|grease fire)\b/i },
  { label: 'Mold Remediation', keywords: /\b(mold|mould|mildew|fungal|microbial)\b/i },
  { label: 'Sewage Backup', keywords: /\b(sewage|sewer|black water|category 3|cat 3|toilet overflow|backup)\b/i },
  { label: 'Storm & Wind Damage', keywords: /\b(storm|wind|hail|hurricane|tornado|tree impact|roof damage)\b/i },
  { label: 'Water Damage', keywords: /\b(water|flood|leak|pipe burst|burst pipe|supply line|freeze|frozen|overflow|intrusion|drying|dehumidif|extraction)\b/i },
  { label: 'Biohazard Cleanup', keywords: /\b(biohazard|trauma|blood|bodily fluid|hoarding|rodent|animal waste)\b/i },
  { label: 'Vandalism & Theft', keywords: /\b(vandal|theft|burglar|malicious|broken window)\b/i },
  { label: 'Contents & Pack-Out', keywords: /\b(content|contents|pack ?out|pack-out|inventory|storage|electronics cleaning|textile)\b/i },
  { label: 'Reconstruction & Rebuild', keywords: /\b(reconstruction|rebuild|remediate|repair estimate|rehab|remodel)\b/i }
];

function classifyLoss(text: string): string {
  for (const rule of LOSS_RULES) {
    if (rule.keywords.test(text)) return rule.label;
  }
  return '';
}

// ---------------------------------------------------------------------------
// SCOPE / LINE-ITEM EXTRACTION
// ---------------------------------------------------------------------------

const UNITS = ['SF', 'SQ FT', 'SQFT', 'SQUARE FEET', 'LF', 'L.F.', 'LINEAR FEET', 'FT', 'IN', 'EA', 'EACH', 'PC', 'PCS', 'CY', 'SY', 'GAL', 'HR', 'DAY', 'SQ', 'ROLL', 'SHT', 'BD', 'SET', 'PR', 'LB', 'TON', 'MO', 'WK'];

const QUANTITY_UNIT_RE = new RegExp(String.raw`(\d{1,6}(?:[.,]\d{1,3})?)\s*(${UNITS.map((u) => u.replace(/\./g, '\\.')).join('|')})\b\.?`, 'i');

const QTY_SCAN_RE = new RegExp(String.raw`(\d{1,6}(?:[.,]\d{1,3})?)\s*(${UNITS.map((u) => u.replace(/\./g, '\\.')).join('|')})\b\.?`, 'gi');

interface QuantityMatch {
  index: number;
  quantity: string;
  unit: string;
}

/**
 * Find the real quantity/unit for a scope line.
 *
 * A naive first match reads "Remove 1/2 in. drywall - 96 SF" as 2 IN, so every
 * fractional dimension seen in an estimate corrupted the item. Candidates that are
 * part of a fraction or a bare inch/foot dimension are skipped, trade units
 * (SF/LF/EA/...) are preferred, and the trailing quantity column wins ties.
 */
function findQuantityMatch(line: string): QuantityMatch | null {
  const candidates: Array<QuantityMatch & { weight: number }> = [];
  QTY_SCAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = QTY_SCAN_RE.exec(line);
  while (match) {
    const before = match.index > 0 ? line[match.index - 1] : '';
    const unit = match[2].toUpperCase().replace(/\s+/g, ' ');
    const isDimensionUnit = unit === 'IN' || unit === 'FT';
    const isFraction = before === '/' || (isDimensionUnit && /[\d./]/.test(before));
    if (!isFraction) {
      candidates.push({
        index: match.index,
        quantity: match[1].replace(/,/g, ''),
        unit,
        weight: isDimensionUnit ? 1 : 2
      });
    }
    if (candidates.length > 12) break;
    match = QTY_SCAN_RE.exec(line);
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.weight - left.weight || right.index - left.index);
  const best = candidates[0];
  return { index: best.index, quantity: best.quantity, unit: best.unit };
}

const ACTION_WORDS = /\b(remove|removal|install|replace|detach|reset|re-set|paint|prime|caulk|sand|patch|texture|demo|demolition|tear ?out|cut ?out|extract|dry|dryout|dry-out|dehumidif\w*|clean|cleaning|vacuum|sanitize|disinfect|deodor\w*|fog|seal|grout|lay|glue|nail|screw|hang|set|install|disconnect|reconnect|cap|reroute|rewire|bond|mask|protect|move|pack|inventory|haul|dispose|remove debris|skim|float|finish|stain|urethane|carpet|tile|floor|drywall|sheetrock|insulation|trim|baseboard|casing|cabinet|countertop|door|window|shelv\w*|fixture|outlet|switch|faucet|toilet|sink|appliance|containment|scrubber|hepa|barrier|dumpster|subfloor)\b/i;

const NOISE_ITEM_RE = /^(?:total|subtotal|grand total|overhead|profit|o\s*&\s*p|tax|sales tax|permit|permits|fee|fees|deductible|depreciation|recoverable depreciation|non-recoverable|line item total|material sales tax|equipment sales tax|general conditions|summary|estimate total|net claim|replacement cost|acv|rcv|description|qty|unit price|line total|item|quantity)\b/i;

interface ScopeLine {
  description: string;
  quantity: string;
  unit: string;
  room: string;
  /** The untouched row text, still carrying trailing markers such as "no charge per adjuster". */
  raw?: string;
}

const ROOM_HEADER_RE = /^(?:room|area|location|floor|level)\s*(?:name)?\s*[:#-]?\s*(.{2,48})$/i;
const DIMENSION_RE = /(\d{1,3})\s*(?:'|ft|feet)?\s*(?:x|by|\*)\s*(\d{1,3})\s*(?:'|ft|feet)?/i;

function cleanLineDescription(raw: string): string {
  let text = raw.trim();
  text = text.replace(/\s{2,}/g, '  ');
  text = text.replace(new RegExp(String.raw`\s*\$?\d[\d,]*\.?\d*\s*$`, 'g'), '');
  text = text.replace(/\s*\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b\s*$/g, '');
  text = text.replace(/\s{2,}/g, ' ').trim();
  text = text.replace(/^[-•*\d.)\s]+/, '').trim();
  // A scope line is usually "description - qty unit"; the separator is left behind
  // once the quantity column is cut off.
  text = text.replace(/[\s\-–—:|,;/]+$/, '').trim();
  return text;
}

function extractScopeLines(text: string): { lines: ScopeLine[]; rooms: string[] } {
  const rawLines = text.split('\n');
  const results: ScopeLine[] = [];
  const rooms: string[] = [];
  let currentRoom = '';

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || line.length < 3) continue;

    const roomHeader = line.match(ROOM_HEADER_RE);
    if (roomHeader && roomHeader[1] && !/\d{2,}/.test(roomHeader[1]) && !QUANTITY_UNIT_RE.test(roomHeader[1])) {
      currentRoom = titleCaseName(roomHeader[1]).trim();
      if (currentRoom && !rooms.includes(currentRoom)) rooms.push(currentRoom);
      continue;
    }

    if (NOISE_ITEM_RE.test(line)) continue;
    if (/^[\d\s.,$()%-]+$/.test(line)) continue;

    const qtyMatch = findQuantityMatch(line);
    const description = cleanLineDescription(qtyMatch ? line.slice(0, qtyMatch.index) : line);

    if (description.length < 4) continue;
    const letters = description.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) continue;
    if (NOISE_ITEM_RE.test(description)) continue;

    const hasAction = ACTION_WORDS.test(description);
    // Credited, omitted, and "no charge" rows often carry no action verb or
    // quantity at all, so they fail the scope-item gates below. They must survive
    // to the DO NOT PERFORM list instead of being silently dropped.
    const exclusionRow = isExclusionLine(line) || isExclusionLine(description);
    const isSectionLike = /^[A-Z][A-Z /&,'-]{6,}$/.test(description) && !hasAction;
    if (isSectionLike && !exclusionRow) continue;

    const dimension = description.match(DIMENSION_RE);
    const hasQuantity = Boolean(qtyMatch || dimension);
    // A line with neither a trade action verb nor a measurable quantity is prose
    // (a cover note, an email footer, an adjuster comment) - not a scope item.
    if (!hasAction && !hasQuantity && !exclusionRow) continue;
    if (!hasQuantity && /[.!?]\s+[A-Z]/.test(description) && !exclusionRow) continue;
    if (!hasAction && letters.length < 10 && !exclusionRow) continue;

    const quantity = qtyMatch ? qtyMatch.quantity : dimension ? `${dimension[1]}x${dimension[2]}` : '';
    const unit = qtyMatch ? qtyMatch.unit : dimension ? 'FT' : '';

    results.push({
      description: description.slice(0, 240),
      quantity,
      unit,
      room: currentRoom,
      raw: line.slice(0, 240)
    });
  }

  return { lines: results, rooms };
}

function scopeLineKey(line: ScopeLine): string {
  return line.description
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, '')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attach a trade crew to a real scope line using weighted keyword scoring. */
export function classifyTrade(description: string): string {
  const text = description.toLowerCase();
  const scores = new Map<string, number>();

  // Stripping a substrate (drywall, plaster, insulation, subfloor) is controlled
  // demolition no matter which finishing crew owns the material.
  if (DEMOLITION_VERBS.test(text) && TEAR_OUT_MATERIALS.test(text)) {
    return SEVEN_CREWS[0];
  }

  for (const rule of TRADE_RULES) {
    let score = 0;
    for (const keyword of rule.subjects) {
      if (text.includes(keyword)) score += 9 + Math.min(keyword.length / 6, 2);
    }
    for (const keyword of rule.actions) {
      if (text.includes(keyword)) score += 3;
    }
    if (score > 0) scores.set(rule.name, score);
  }

  if (DEMOLITION_VERBS.test(text) && BUILDING_MATERIALS.test(text)) {
    const demolition = SEVEN_CREWS[0];
    scores.set(demolition, (scores.get(demolition) || 0) + 8);
  }
  if (/^(install|reinstall|lay|set|hang|reset|replace)\b/i.test(text)) {
    for (const crew of [SEVEN_CREWS[1], SEVEN_CREWS[2], SEVEN_CREWS[3], SEVEN_CREWS[4], SEVEN_CREWS[5]]) {
      if (scores.has(crew)) scores.set(crew, (scores.get(crew) || 0) + 2);
    }
  }

  let bestTrade = '';
  let bestScore = 0;
  for (const [trade, score] of scores) {
    if (score > bestScore) {
      bestTrade = trade;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? bestTrade : '';
}

function mapLinesToTrades(lines: ScopeLine[]): { groups: ExtractedTradeGroup[]; lineItems: ExtractedLineItem[] } {
  const lineItems: ExtractedLineItem[] = [];
  const groups = new Map<string, string[]>();

  for (const line of lines) {
    const trade = classifyTrade(line.description) || GENERAL_TRADE;
    const label = line.quantity ? `${line.description} (${line.quantity}${line.unit ? ` ${line.unit}` : ''})` : line.description;
    if (!groups.has(trade)) groups.set(trade, []);
    groups.get(trade)!.push(label);
    lineItems.push({ description: line.description, quantity: line.quantity, unit: line.unit, room: line.room, trade });
  }

  const ordered: ExtractedTradeGroup[] = [];
  for (const crew of SEVEN_CREWS) {
    const tasks = groups.get(crew);
    if (tasks && tasks.length > 0) ordered.push({ tradeName: crew, tasks });
  }
  const general = groups.get(GENERAL_TRADE);
  if (general && general.length > 0) ordered.push({ tradeName: GENERAL_TRADE, tasks: general });

  return { groups: ordered, lineItems };
}

// ---------------------------------------------------------------------------
// FIELD WORK ORDER PACKAGE
//
// Converts validated scope rows into what a crew actually needs on site:
// financial data, Xactimate category codes and insurance shorthand are removed,
// each row is restated as a verb-first field action with its measured quantity,
// and the rows are grouped into the seven crew sections with the safety,
// material and quality-control blocks the crew lead signs off against.
// ---------------------------------------------------------------------------

const FIELD_MONEY_RE = /(?:\$|usd\b)\s?\d[\d,]*(?:\.\d{1,2})?/gi;
const UNIT_RATE_RE = /\b\d[\d,]*(?:\.\d{1,4})?\s*\/\s*(?:sf|sq\.?\s?ft|lf|l\.?f\.?|lm|ea|sy|cy|sq|hr|gal|bd\.?\s?ft|msf|sq\.?\s?yd)\b\.?/gi;
const FINANCE_WORD_RE = /\b(?:o\s*&\s*p|overhead\s+(?:&|and)\s+profit|profit|sales tax|material sales tax|equipment sales tax|tax|deductible|depreciation|recoverable depreciation|non[- ]recoverable(?: depreciation)?|acv|rcv|replacement cost|net claim|markup|sub-?total|grand total|estimate total|line total|unit price)\b/gi;

/** Xactimate category/selector prefixes (e.g. `FNH MN`, `PNT B2`, `DMO`, `WTR`). */
const XACTIMATE_CODES = [
  'FNH', 'FNC', 'FND', 'PNT', 'DMO', 'DMK', 'WTR', 'WDR', 'LMN', 'SFG', 'RFG', 'INS', 'CLN', 'HMR',
  'ACT', 'APL', 'BSC', 'CAB', 'CRP', 'CTR', 'ELE', 'FLR', 'FRM', 'GYP', 'HVA', 'MIR', 'MLD', 'PLM',
  'PLB', 'RSD', 'STL', 'TIL', 'VNL', 'VCT', 'WOD', 'WPF', 'WRE', 'WRN', 'COT', 'DOR', 'WIN', 'BLK',
  'CON', 'MAS', 'MTL', 'LIT', 'TMP', 'SHT', 'SKT', 'SPK', 'STC', 'SWP', 'TFG', 'STN', 'SHL', 'REC',
  'SWS', 'STS', 'VEN', 'CLG', 'EQS', 'GNT', 'LNT', 'MNS', 'PWD', 'SLD', 'SPC', 'SST', 'WDP'
];
const XACTIMATE_CODE_RE = new RegExp(
  String.raw`\b(?:${XACTIMATE_CODES.join('|')})\b(?:\s+[A-Z0-9]{1,3})?`,
  'g'
);

/**
 * Strip everything a field crew must never see - dollar amounts, unit rates,
 * O&P/tax/depreciation wording and Xactimate category codes - then tidy the
 * leftover punctuation and whitespace.
 */
export function sanitizeFieldScope(text: string): string {
  let out = String(text || '');
  out = out.replace(FIELD_MONEY_RE, ' ');
  out = out.replace(UNIT_RATE_RE, ' ');
  out = out.replace(FINANCE_WORD_RE, ' ');
  out = out.replace(XACTIMATE_CODE_RE, ' ');
  out = out.replace(/\(\s*\)/g, ' ');
  out = out.replace(/\s*([,;:/])\s*(?=[,;:/])/g, '$1');
  out = out.replace(/\s{2,}/g, ' ').trim();
  out = out.replace(/^[-–—:|,;\s]+/, '');
  out = out.replace(/[\s\-–—:|,;/]+$/, '');
  out = out.replace(/^&\s*/, '').replace(/\s*&$/, '').trim();
  return out;
}

interface FieldInstructionRule {
  match: RegExp;
  rewrite: string;
  /** Used instead of `rewrite` when the row starts with a tear-out verb. */
  removeRewrite?: string;
}

/**
 * Rows that start with a tear-out verb describe labour to remove. Rewriting those
 * with the crew's standing install detail for the material tells the crew to do
 * the opposite of the scope ("Remove 1/2 in. drywall" must not read "Install and
 * finish drywall to a level-4 standard").
 */
const REMOVAL_INTENT_RE = /^(?:remove\w*|re-?move\w*|removal|demo\w*|detach\w*|disconnect\w*|pull\w*|pry\w*|pop\w*|chip\w*|cut\w*|scrape\w*|strip\w*|tear\w*|extract\w*|abate\w*|discard\w*|dispose\w*|haul\w*)\b/i;

/** Imperative translations of the insurance shorthand that appears in estimates. */
const FIELD_INSTRUCTION_RULES: FieldInstructionRule[] = [
  {
    match: /\b(?:msk|mask(?:ing)?|prep)\b.*\b(?:paint|pnt|finish)\b|\btape only\b/i,
    rewrite: "Apply high-tack painter's masking tape along all baseboard and casing perimeters to protect adjacent surfaces."
  },
  {
    match: /\b(?:remove|removal|demo|demolition)\b.*\btil(?:e|es|ing)\b|\bchip\b.*\btile\b/i,
    rewrite: 'Chip away the tile down to bare substrate, remove bonded thinset mortar, and mechanically grind the surface smooth for new floor installation.'
  },
  {
    match: /\b(?:remove|removal|pull)\b.*\b(?:carpet|pad|tack strip)\b/i,
    rewrite: 'Cut and remove carpet and pad in full widths, pull all tack strip, staples, and adhesive, and bag the debris for haul-off.'
  },
  {
    match: /\b(?:remove|detach|pull|pry|pop)\b.*\b(?:baseboard|base board|trim|casing|crown|shoe mold)\b/i,
    rewrite: 'Pry the trim free with a flat bar and wall protector, keeping lengths intact and labeled by room for reinstallation.'
  },
  {
    match: /\b(?:reset|re-?set|re-?install|install|set)\b.*\b(?:baseboard|base board|trim|casing|crown|shoe mold)\b/i,
    rewrite: 'Reinstall the trim tight to the wall and square at every corner, then fill nail holes and caulk the top edge.'
  },
  {
    match: /\b(?:detach|remove|disconnect)\b.*\b(?:toilet|sink|faucet|angle stop|supply line|p-?trap|dishwasher|refrigerator|range|appliance|washer|dryer)\b/i,
    rewrite: 'Shut off the supply, disconnect the fixture or appliance, cap the line, and stage the unit out of the work area for reset.'
  },
  {
    match: /\b(?:reset|re-?set|re-?install|install|set|reconnect)\b.*\b(?:toilet|sink|faucet|angle stop|supply line|p-?trap|dishwasher|refrigerator|range|appliance|washer|dryer)\b/i,
    rewrite: 'Reset the fixture or appliance with new supply lines and seals, then pressure-test every connection for leaks before closing up.'
  },
  {
    match: /\b(?:detach|remove|drop)\b.*\b(?:outlet|receptacle|gfci|switch|light|fixture|fan|smoke detector|can light)\b/i,
    rewrite: 'De-energize the circuit, detach the device or fixture, and cap the conductors in the box per local code.'
  },
  {
    match: /\b(?:reset|re-?install|install|replace|reconnect)\b.*\b(?:outlet|receptacle|gfci|switch|light|fixture|fan|smoke detector|can light)\b/i,
    rewrite: 'Terminate the conductors on the new device or fixture, mount it plumb to the finished surface, and confirm the circuit operates.'
  },
  {
    match: /\b(?:install|lay|replace|reset)\b.*\b(?:floor|flooring|lvp|lvt|vinyl|laminate|hardwood|membrane|underlayment|plank)\b/i,
    rewrite: 'Install the flooring over a clean, flat, moisture-tested substrate, holding the specified expansion gap at every perimeter and transition.',
    removeRewrite: 'Remove the existing floor covering and adhesive down to a bare, clean substrate, and bag the debris for haul-off.'
  },
  {
    match: /\b(?:drywall|sheet ?rock|gypsum|sheetrock)\b/i,
    rewrite: 'Install and finish drywall to a level-4 standard: tape and bed all joints, coat fasteners, and sand smooth ready for primer.',
    removeRewrite: 'Remove the damaged drywall back to sound material in full sheets, cut clean straight edges at the nearest framing member, and haul the debris to the staging area.'
  },
  {
    match: /\bskim coat\b|\blevel[- ]?4\b|\btexture\b|\bknock ?down\b|\borange peel\b/i,
    rewrite: 'Skim and texture the repaired surfaces to match the existing finish, feathering edges so no lap marks show under light.',
    removeRewrite: 'Scrape and sand the existing texture off the repaired surfaces, feather the edges, and vacuum the dust before any coating.'
  },
  {
    match: /\b(?:prime|primer)\b/i,
    rewrite: 'Apply one coat of primer to all repaired and bare surfaces and allow full dry time before the finish coats.'
  },
  {
    match: /\b(?:paint|repaint|pnt|finish coat)\b/i,
    rewrite: 'Apply two finish coats by spray and back-roll, keeping a wet edge for an even sheen across walls, ceilings, and trim.',
    removeRewrite: 'Sand and strip the failing coating back to a sound substrate, feather the edges smooth, and dust off the surface before recoating.'
  },
  {
    match: /\b(?:stain|urethane|polyurethane|lacquer|varnish)\b/i,
    rewrite: 'Apply stain to the specified tone and topcoat with urethane, sanding between coats for a smooth, even finish.'
  },
  {
    match: /\b(?:caulk|caulking|sealant|seal)\b/i,
    rewrite: 'Caulk all joints and penetrations with paintable sealant, tool the bead, and wipe squeeze-out while still wet.',
    removeRewrite: 'Cut the old caulk bead out of the joint with a utility knife, scrape the joint clean, and remove the debris before recaulking.'
  },
  {
    match: /\b(?:clean|vacuum|wipe|mop|sanitize|disinfect|deodor|ozone|hydroxyl)\b/i,
    rewrite: 'Clean to a move-in standard: HEPA vacuum every surface, wipe trim and glass, scrub hard floors, and deodorize the space.'
  },
  {
    match: /\b(?:dumpster|debris|haul|dispose|dump trailer)\b/i,
    rewrite: 'Load all construction debris into the dump trailer, sweep the work area clean, and schedule haul-off with the superintendent.'
  },
  {
    match: /\b(?:grind|level|float|self[- ]?level|floor prep)\b/i,
    rewrite: 'Grind and float the substrate flat to within 1/8 in. over 10 ft, then vacuum it clean before any covering goes down.'
  },
  {
    match: /\b(?:door|doors|sidelite|bifold|jamb)\b/i,
    rewrite: 'Detach or hang the door slab and hardware, shim the jambs square and plumb, and confirm latch alignment and swing.',
    removeRewrite: 'Remove the door slab, jambs, and hardware, label the salvaged pieces by room, and store them flat for reinstallation.'
  },
  {
    match: /\b(?:cabinet|cabinetry|vanity|counter ?top)\b/i,
    rewrite: 'Detach or set the cabinet and countertop level and plumb, shim as required, and secure to framing and adjacent units.',
    removeRewrite: 'Detach the cabinet, vanity, and countertop without damaging adjacent finishes, and stage or dispose of the unit as directed.'
  },
  {
    match: /\b(?:insulation|batt|blown[- ]in)\b/i,
    rewrite: 'Install insulation to full cavity depth with no gaps or compression, and secure the facing per manufacturer instructions.',
    removeRewrite: 'Remove the wet, compressed, or damaged insulation to full cavity depth and dispose of it in sealed bags.'
  },
  {
    match: /\b(?:containment|barrier|zipper|negative air|air scrubber|hepa|poly)\b/i,
    rewrite: 'Build the dust containment with tension posts, 6 mil poly, zipper doors, and running negative air units before any demolition starts.',
    removeRewrite: 'Take the containment down only after the dust has settled, folding the poly inward and bagging it for disposal.'
  }
];

const VERB_FIRST_RE = /^(?:abate|apply|assemble|attach|block|brush|cap|caulk|chip|clean|clear|coat|cut|demo|demolish|deodorize|detach|disconnect|disinfect|dispose|dry|erect|extract|fill|finish|float|glue|grind|grout|hang|haul|install|label|lay|level|load|mask|measure|mix|mount|nail|pack|paint|patch|place|prepare|prime|protect|pry|pull|re-?install|re-?set|re-?terminate|re-?wire|remove|replace|reset|roll|sand|saw|scrape|screw|seal|secure|set|shim|shut|skim|spray|stage|stain|store|sweep|tape|tear ?out|test|texture|tile|trim|treat|tuck|vacuum|wipe)\b/i;

function neutralImperative(description: string, trade: string): string {
  if (VERB_FIRST_RE.test(description)) {
    return /^removal\b/i.test(description)
      ? description.replace(/^removal/i, 'Remove')
      : description;
  }
  const prefix = trade.includes('Flooring') ? 'Install'
    : trade.includes('Painting') ? 'Apply finish to'
      : trade.includes('Cleanup') ? 'Clean and clear'
        : trade.includes('Plumbing') ? 'Disconnect and reset'
          : trade.includes('Electrical') ? 'De-energize and re-terminate'
            : trade.includes('Carpentry') ? 'Set and align'
              : 'Remove';
  return `${prefix} ${description.charAt(0).toLowerCase()}${description.slice(1)}`;
}

function withMeasurement(instruction: string, quantity: string, unit: string): string {
  if (!quantity) return instruction;
  return `${instruction} (${quantity}${unit ? ` ${unit}` : ''})`;
}

/**
 * Restate a scope row as the physical labour action the crew performs, keeping
 * the measured quantity that came off the estimate.
 */
export function buildFieldInstruction(description: string, quantity: string, unit: string, trade: string): string {
  const clean = sanitizeFieldScope(description);
  if (!clean) return '';
  const removal = REMOVAL_INTENT_RE.test(clean);
  for (const rule of FIELD_INSTRUCTION_RULES) {
    if (!rule.match.test(clean)) continue;
    const rewrite = removal && rule.removeRewrite ? rule.removeRewrite : rule.rewrite;
    return withMeasurement(rewrite, quantity, unit);
  }
  return withMeasurement(`${neutralImperative(clean, trade)}.`, quantity, unit);
}

interface TradeFieldGuide {
  scopeSummary: string;
  safetyProtocols: string[];
  materials: string[];
  qualityChecks: string[];
}

/** Standing protocols each crew follows on every job (from the Hays + Sons field standard). */
const TRADE_FIELD_GUIDES: Record<string, TradeFieldGuide> = {
  [SEVEN_CREWS[0]]: {
    scopeSummary: 'Contents handling, site protection, controlled demolition, and debris staging for this scope.',
    safetyProtocols: [
      'Erect dust containment (tension posts, 6 mil poly, zipper doors) with negative air running before any tear-out.',
      'Photograph and protect all contents; pack out, label by room, and store off the work area.',
      'Wear N95/HEPA dust protection, eye protection, and cut-resistant gloves for all tear-out.'
    ],
    materials: ['6 mil poly containment, zipper doors, tape', 'Dump trailer or dumpster staged on site'],
    qualityChecks: [
      'Containment sealed and negative air holding before demolition.',
      'All specified tear-out complete; debris hauled to the staging area, floor swept clean.',
      'Substrate exposed and ready for the next trade; no damaged adjacent finishes.'
    ]
  },
  [SEVEN_CREWS[1]]: {
    scopeSummary: 'Plumbing and mechanical detach/reset plus appliance handling for this scope.',
    safetyProtocols: [
      'Locate and tag the main water shut-off and gas/mechanical isolation points before starting.',
      'Cap or valve off all opened lines; never leave an open supply line unattended.',
      'Lockout/tagout any appliance or equipment circuit before detaching.'
    ],
    materials: ['New supply lines, angle stops, and wax rings as required', 'Pipe dope/thread sealant and PEX or copper repair couplings'],
    qualityChecks: [
      'Every connection pressure-tested and leak-free with the line charged.',
      'Fixtures level, secure, and sealed to the finished surface with no movement.',
      'Appliances returned to position with clearance for doors and drawers.'
    ]
  },
  [SEVEN_CREWS[2]]: {
    scopeSummary: 'Electrical de-energize, detach/reset, and device termination for this scope.',
    safetyProtocols: [
      'De-energize and lockout/tagout the affected circuits; verify with a non-contact tester before work.',
      'Work to local electrical code; keep all boxes and conductors accessible.',
      'No live work - if a circuit cannot be isolated, stop and notify the superintendent.'
    ],
    materials: ['Devices (GFCI/receptacle/switch) and plates to match existing grade', 'Box extenders, wire nuts, and grounding pigtails'],
    qualityChecks: [
      'All devices plumb, flush to the finished wall, and firmly mounted.',
      'Continuity and bond verified; every circuit function-tested before sign-off.',
      'Plates installed with no gaps and no exposed conductors.'
    ]
  },
  [SEVEN_CREWS[3]]: {
    scopeSummary: 'Substrate prep and floor covering installation for this scope.',
    safetyProtocols: [
      'Verify the substrate is dry, clean, and free of debris before any material is opened.',
      'Moisture-test and record readings for concrete or slab-on-grade substrates.',
      'Keep materials acclimating on site for the manufacturer-required time before install.'
    ],
    materials: ['Flooring and underlayment per the specified grade and thickness', 'Seam sealer, adhesive or click-lock system, and transition strips'],
    qualityChecks: [
      'Substrate flat within tolerance and free of high spots, dust, and old adhesive.',
      'Perimeter expansion gap held at every wall and fixed object; transitions set level.',
      'No hollow spots, no lifted seams, and no visible pattern repeats or mismatched dye lots.'
    ]
  },
  [SEVEN_CREWS[4]]: {
    scopeSummary: 'Finish carpentry, cabinetry, and door work for this scope.',
    safetyProtocols: [
      'Protect finished floors and walls with drop cloths and wall protectors while prying or setting trim.',
      'Label and store salvaged trim, doors, and hardware flat and dry by room.',
      'Use shims against framing only - never against finished drywall.'
    ],
    materials: ['Trim and casing matching existing profile', 'Construction adhesive, finish nails, shims, and matching hardware'],
    qualityChecks: [
      'Trim tight to the wall with miters closed and joints aligned.',
      'Doors square, plumb, and swinging freely with even margins and working hardware.',
      'Cabinets level, plumb, and secured with even reveals between doors and drawers.'
    ]
  },
  [SEVEN_CREWS[5]]: {
    scopeSummary: 'Surface preparation, priming, and finish painting for this scope.',
    safetyProtocols: [
      'Mask floors, adjacent surfaces, and hardware before any coating is applied.',
      'Ventilate the work area and use the specified PPE/respirator for spraying.',
      'Verify adjacent trades are complete - no dust-generating work after finish coats.'
    ],
    materials: ['Primer and two-coat finish system in the specified sheen', 'Paintable caulk, spackle, and the specified sanding grits'],
    qualityChecks: [
      'Surfaces sanded and dusted; no visible drywall joints, fasteners, or pinholes.',
      'Full, even coverage with no lap marks, drips, or holidays under light.',
      'Cut lines crisp at ceilings, casings, and corners; hardware and glass clean.'
    ]
  },
  [SEVEN_CREWS[6]]: {
    scopeSummary: 'Final debris removal and move-in level cleaning for this scope.',
    safetyProtocols: [
      'Stage debris only in the designated dump area; keep driveways, exit paths, and panel access clear.',
      'No open flames or smoke on site; follow site parking and access rules.',
      'Remove containment only after the superintendent confirms all demolition dust has settled.'
    ],
    materials: ['HEPA vacuum, microfiber cloths, and approved neutral cleaners', 'Dump trailer for final haul-off'],
    qualityChecks: [
      'All construction debris removed from the property; work area swept and blown clear.',
      'Windows, trim, and hard floors wiped; no dust on horizontal surfaces.',
      'Final walk completed with the superintendent and any punch items closed out.'
    ]
  },
  [GENERAL_TRADE]: {
    scopeSummary: 'Assigned restoration scope that does not belong to a single trade crew.',
    safetyProtocols: [
      'Confirm the work area is safe, contained, and cleared for access before starting.',
      'Wear site PPE (eye protection, gloves, and dust protection as required).'
    ],
    materials: ['Materials as specified in the approved scope for this item'],
    qualityChecks: ['Completed work matches the approved scope and is photographically verified.']
  }
};

const MATERIAL_HINT_RE = /\b(?:\d{1,3}\s*mil|\d{1,2}\/\d{1,2}\s*(?:in|")|\d+\s*ga(?:uge)?|lvp|lvt|vinyl plank|laminate|vinyl|ceramic|porcelain|tile|hardwood|sheet vinyl|underlayment|membrane|drywall|sheetrock|insulation|r-?value|primer|paint|stain|urethane|grout|thinset|self[- ]level|quarter round|baseboard|casing|cabinet|counter ?top|stainless|cultured marble|granite|quartz)\b/i;

/** Pull the material specifications that are actually named in the scope rows. */
function collectMaterials(descriptions: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const description of descriptions) {
    if (!MATERIAL_HINT_RE.test(description)) continue;
    const label = sanitizeFieldScope(description).slice(0, 110);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 6) break;
  }
  return out;
}

/** Credited, omitted, or explicitly excluded scope - the crew must not perform it. */
const EXCLUSION_RE = /\b(?:do not (?:perform|install|replace|do)|d\/n|no charge|omit(?:ted)?|excluded?|credit(?:ed)?|not included|deleted|deletion|cancel(?:led|ed)|void|removed from scope|deduct)\b/i;

function isExclusionLine(description: string): boolean {
  const text = sanitizeFieldScope(description);
  if (!text || text.length < 4) return false;
  return EXCLUSION_RE.test(text) && !/^\s*(?:do not|dn)\s*$/i.test(text);
}

/**
 * Group validated scope rows into per-crew field work orders with the five
 * mandated sub-blocks, keeping the room grouping and measured quantities.
 */
export function buildFieldPackage(
  lines: ExtractedLineItem[],
  exclusions: Array<{ description: string; trade: string }> = []
): FieldWorkOrderSection[] {
  const order = [...SEVEN_CREWS, GENERAL_TRADE];
  const byTrade = new Map<string, ExtractedLineItem[]>();

  for (const line of lines) {
    const trade = order.includes(line.trade as any) ? line.trade : GENERAL_TRADE;
    if (!byTrade.has(trade)) byTrade.set(trade, []);
    byTrade.get(trade)!.push(line);
  }

  const sections: FieldWorkOrderSection[] = [];
  for (const trade of order) {
    const items = byTrade.get(trade) || [];
    const tradeExclusions = exclusions.filter((entry) => entry.trade === trade).map((entry) => entry.description);
    if (items.length === 0 && tradeExclusions.length === 0) continue;

    const guide = TRADE_FIELD_GUIDES[trade] || TRADE_FIELD_GUIDES[GENERAL_TRADE];
    const rooms: FieldWorkOrderRoom[] = [];
    for (const item of items) {
      const roomName = item.room || 'General';
      let room = rooms.find((entry) => entry.roomName === roomName);
      if (!room) {
        room = { roomName, instructions: [] };
        rooms.push(room);
      }
      const instruction = item.instruction || buildFieldInstruction(item.description, item.quantity, item.unit, trade);
      if (instruction && !room.instructions.includes(instruction)) room.instructions.push(instruction);
    }

    const roomLabel = rooms.map((room) => room.roomName).filter((name) => name !== 'General');
    const scopeSummary = items.length === 0
      ? guide.scopeSummary
      : `${items.length} scope item${items.length === 1 ? '' : 's'}${roomLabel.length > 0 ? ` across ${roomLabel.slice(0, 6).join(', ')}` : ''} - ${guide.scopeSummary}`;

    sections.push({
      tradeName: trade,
      scopeSummary,
      safetyProtocols: [...guide.safetyProtocols],
      rooms,
      materials: [...new Set([...collectMaterials(items.map((item) => item.description)), ...guide.materials])].slice(0, 8),
      qualityChecks: [...guide.qualityChecks],
      exclusions: [...new Set(tradeExclusions)]
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC ESTIMATE PARSER
// ---------------------------------------------------------------------------

export interface ParseEstimateOptions {
  fileName?: string;
  source: EstimateSource;
  documentStats?: DocumentStats;
  baseWarnings?: string[];
  sourceHash?: string;
  rawCharacters?: number;
}

export function parseEstimateText(rawText: string, options: ParseEstimateOptions): EstimateExtraction {
  const text = normalizeDocumentText(rawText);
  const lines = text.split('\n').filter(Boolean);
  const warnings: string[] = [...(options.baseWarnings || [])];

  const customerName = titleCaseName(
    labeledValue(lines, ['named insured', 'insured name', 'insured', 'customer name', 'customer', 'homeowner', 'property owner', 'claimant', 'client'], isPlausiblePersonName)
  );
  const propertyAddress = findAddress(text, lines);
  const phone = findPhone(lines, text);
  const email = findEmail(text);
  const claimNumber = findClaimNumber(lines, text);
  const insuranceCarrier = findCarrier(lines, text);
  const adjusterName = findAdjuster(lines, text);
  const lossType = classifyLoss(text) || 'Restoration';
  const dateOfLoss = findDate(lines, ['date of loss', 'loss date', 'dol', 'date of occurrence', 'occurred']);
  const totalEstimate = findTotal(lines, text);

  const { lines: scopeLines, rooms } = extractScopeLines(text);
  const uniqueScope: ScopeLine[] = [];
  const exclusions: Array<{ description: string; trade: string }> = [];
  const seenKeys = new Set<string>();
  for (const line of scopeLines) {
    // Credited/omitted rows are scope the crews must NOT perform, so they are kept
    // out of the work orders and surfaced as DO NOT PERFORM notes instead.
    const description = sanitizeFieldScope(line.description);
    if (!description) continue;
    line.description = description;
    // The row tail (past the quantity column) can carry the marker, e.g.
    // "Remove ceramic tiling - 48 SF   TIL   no charge per adjuster".
    const exclusionText = isExclusionLine(line.raw || '')
      ? sanitizeFieldScope(line.raw || '') || description
      : description;
    if (isExclusionLine(exclusionText)) {
      exclusions.push({ description: exclusionText, trade: classifyTrade(exclusionText) || GENERAL_TRADE });
      continue;
    }
    const key = `${scopeLineKey(line)}|${line.quantity}|${line.unit}`;
    if (key === '|' || seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueScope.push(line);
    if (uniqueScope.length >= 80) break;
  }

  const { groups: tradeBreakdown, lineItems } = mapLinesToTrades(uniqueScope);
  for (const item of lineItems) {
    item.instruction = buildFieldInstruction(item.description, item.quantity, item.unit, item.trade);
  }
  const fieldPackage = buildFieldPackage(lineItems, exclusions);
  const tasks = uniqueScope.map((line) => (line.quantity ? `${line.description} (${line.quantity}${line.unit ? ` ${line.unit}` : ''})` : line.description));

  const roomBreakdown: ExtractedRoomGroup[] = [];
  for (const room of rooms) {
    const roomTasks = uniqueScope.filter((line) => line.room === room).map((line) => line.description);
    if (roomTasks.length > 0) roomBreakdown.push({ roomName: room, tasks: roomTasks });
  }

  const suggestedTrade = tradeBreakdown
    .filter((group) => group.tradeName !== GENERAL_TRADE)
    .sort((a, b) => b.tasks.length - a.tasks.length)[0]?.tradeName
    || tradeBreakdown[0]?.tradeName
    || '';

  const unitArea = rooms.length > 0 ? rooms.slice(0, 4).join(', ') : uniqueScope.find((line) => line.room)?.room || '';

  // ---------------------------------------------------------------- confidence
  let confidence = 0;
  if (customerName) confidence += 0.22;
  if (propertyAddress) confidence += 0.2;
  if (claimNumber) confidence += 0.12;
  if (tasks.length >= 3) confidence += 0.16;
  else if (tasks.length > 0) confidence += 0.08;
  if (lossType !== 'Restoration') confidence += 0.08;
  if (phone || email) confidence += 0.07;
  if (totalEstimate) confidence += 0.05;
  if (roomBreakdown.length > 0) confidence += 0.05;
  if (lineItems.some((item) => item.quantity)) confidence += 0.05;
  confidence = Math.min(1, Number(confidence.toFixed(3)));

  // ----------------------------------------------------------------- warnings
  if (!customerName) warnings.push('No policyholder/customer name was found in the document.');
  if (!propertyAddress) warnings.push('No property address was found in the document.');
  if (!claimNumber) warnings.push('No claim number was found in the document.');
  if (tasks.length === 0) {
    warnings.push('No line-item scope could be read from this document. Paste the scope/line-item table so work orders can be created.');
  }
  if (tasks.length > 0 && !lineItems.some((item) => item.quantity)) {
    warnings.push('Scope items were found without quantities - verify measurements against the estimate.');
  }
  if (exclusions.length > 0) {
    warnings.push(
      `${exclusions.length} credited/omitted scope line${exclusions.length === 1 ? '' : 's'} were listed as DO NOT PERFORM on the trade work orders.`
    );
  }

  const fileNameBase = (options.fileName || '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const projectNameParts = [
    customerName || propertyAddress || titleCaseName(fileNameBase) || 'Restoration Job',
    lossType
  ];
  const projectName = projectNameParts.filter(Boolean).join(' - ');

  const notes = [
    `Scope and customer details extracted from the submitted ${options.source === 'pdf' ? 'PDF estimate' : 'pasted estimate text'}.`,
    'Every line item requires subcontractor photo verification before sign-off.'
  ].join(' ');

  return {
    projectName,
    customerName,
    propertyAddress,
    phone,
    email,
    claimNumber,
    insuranceCarrier,
    adjusterName,
    lossType,
    dateOfLoss,
    unitArea,
    totalEstimate,
    notes,
    suggestedTrade,
    tasks,
    lineItems,
    tradeBreakdown,
    roomBreakdown,
    fieldPackage,
    confidence,
    warnings: mergeWarnings(warnings),
    extractionMethod: 'deterministic_parser',
    source: options.source,
    sourceHash: options.sourceHash || hashSourceText(text),
    documentStats: options.documentStats || {
      characters: options.rawCharacters ?? rawText.length,
      pages: 1,
      hasTextLayer: true,
      lookedLikeScan: false
    },
    demoTemplatesSuppressed: 0
  };
}

export function hashSourceText(text: string): string {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// SEQUENTIAL ID ALLOCATION (collision free)
// ---------------------------------------------------------------------------

/**
 * Allocate the next sequential id for a prefix (`WO-`, `JOB-`) based on the ids
 * that already exist, so processing the same batch twice can never overwrite an
 * earlier record the way random ids used to.
 */
export function nextSequentialId(prefix: string, existingIds: Iterable<string>, width = 4): string {
  let highest = 0;
  const pattern = new RegExp(`^${prefix.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}(\\d+)$`, 'i');
  for (const id of existingIds) {
    const match = String(id || '').trim().match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}

// ---------------------------------------------------------------------------
// AI ENRICHMENT (STRICTLY VALIDATED AGAINST THE DOCUMENT)
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

/**
 * Google retires model names regularly (the whole 1.5/2.0 family now answers 404
 * for existing API keys), so this is only a preference order. When every name in
 * the chain is rejected the endpoint asks the key's own model list which model it
 * may actually call, which keeps extraction working across renames.
 */
const DEFAULT_MODELS = [
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];
const DEFAULT_TIMEOUT_MS = 25_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 8_000;
/** Keeps a cold estimate upload inside the serverless request budget. */
const TOTAL_AI_BUDGET_MS = 45_000;
/**
 * Names answered with 404, and the model discovered through ListModels. Both are
 * scoped to the API key that produced them: a 404 means "not available to *your*
 * project" (that is how Google words it), and callers may post their own key, so
 * one key's dead list must never suppress another key's models in a warm instance.
 */
const RETIRED_MODELS = new Map<string, Set<string>>();
const DISCOVERED_MODEL = new Map<string, string>();
/** Bounded so long-lived instances cannot grow this without limit. */
const MODEL_SCOPE_LIMIT = 24;

function modelScope(apiKey: string): string {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
}

function retiredModelsFor(scope: string): Set<string> {
  const existing = RETIRED_MODELS.get(scope);
  if (existing) return existing;
  const created = new Set<string>();
  if (RETIRED_MODELS.size >= MODEL_SCOPE_LIMIT) {
    const oldest = RETIRED_MODELS.keys().next().value;
    if (oldest !== undefined) RETIRED_MODELS.delete(oldest);
  }
  RETIRED_MODELS.set(scope, created);
  return created;
}

export interface AiEnrichmentResult {
  extraction: EstimateExtraction;
  usedAi: boolean;
  method: string;
  warnings: string[];
}

function aiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      customerName: { type: 'STRING' },
      propertyAddress: { type: 'STRING' },
      phone: { type: 'STRING' },
      email: { type: 'STRING' },
      claimNumber: { type: 'STRING' },
      insuranceCarrier: { type: 'STRING' },
      adjusterName: { type: 'STRING' },
      lossType: { type: 'STRING' },
      dateOfLoss: { type: 'STRING' },
      unitArea: { type: 'STRING' },
      totalEstimate: { type: 'STRING' },
      lineItems: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING' },
            quantity: { type: 'STRING' },
            unit: { type: 'STRING' },
            room: { type: 'STRING' },
            trade: { type: 'STRING' },
            instruction: { type: 'STRING' }
          },
          required: ['description']
        }
      },
      trades: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            tradeName: { type: 'STRING' },
            scopeSummary: { type: 'STRING' },
            safetyProtocols: { type: 'ARRAY', items: { type: 'STRING' } },
            rooms: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  roomName: { type: 'STRING' },
                  instructions: { type: 'ARRAY', items: { type: 'STRING' } }
                },
                required: ['instructions']
              }
            },
            materials: { type: 'ARRAY', items: { type: 'STRING' } },
            qualityChecks: { type: 'ARRAY', items: { type: 'STRING' } },
            exclusions: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['tradeName']
        }
      },
      scopeNotes: { type: 'STRING' }
    },
    required: ['lineItems']
  };
}

/** Short, human-readable reason for a provider failure - never the raw JSON body. */
function describeGeminiFailure(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = String(parsed?.error?.message || parsed?.error?.status || '');
  } catch {
    detail = String(body || '');
  }
  detail = detail.replace(/\s+/g, ' ').trim();

  if (status === 401 || /api key not valid|invalid api key|api_key_invalid/i.test(detail)) {
    return 'the Gemini API key was rejected';
  }
  if (status === 403) return 'this API key is not permitted to call the Gemini API';
  if (status === 429 || /quota|rate limit|resource_exhausted/i.test(detail)) {
    return 'the Gemini quota/rate limit was reached';
  }
  if (status === 404 || /no longer available|not found|is not supported/i.test(detail)) {
    return 'model not available';
  }
  if (status >= 500) return `the Gemini service returned HTTP ${status}`;
  if (status === 400 && /schema|invalid json payload/i.test(detail)) {
    return 'Gemini rejected the request schema';
  }
  return detail ? `Gemini rejected the request: ${detail.slice(0, 110)}` : `Gemini request failed (HTTP ${status})`;
}

interface GeminiHttpResult {
  status: number;
  body: string;
}

async function geminiFetch(url: string, init: RequestInit, timeoutMs: number): Promise<GeminiHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    return { status: 0, body: aborted ? `request timed out after ${timeoutMs}ms` : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiAttempt {
  ok: boolean;
  payload?: AiPayload;
  status: number;
  reason: string;
}

async function requestExtraction(
  model: string,
  apiKey: string,
  contents: unknown[],
  timeoutMs: number
): Promise<GeminiAttempt> {
  const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: aiSchema(), temperature: 0 }
  });

  let result = await geminiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, timeoutMs);
  // Transient provider errors are worth exactly one retry.
  if (result.status === 429 || result.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    result = await geminiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, timeoutMs);
  }

  if (result.status !== 200) {
    return { ok: false, status: result.status, reason: describeGeminiFailure(result.status, result.body) };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return { ok: false, status: result.status, reason: 'Gemini returned a non-JSON response' };
  }

  if (parsed?.promptFeedback?.blockReason) {
    return { ok: false, status: result.status, reason: 'Gemini blocked the document with its safety filter' };
  }
  const candidate = parsed?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  if (!text) {
    return {
      ok: false,
      status: result.status,
      reason: candidate?.finishReason && candidate.finishReason !== 'STOP'
        ? `Gemini stopped early (${candidate.finishReason})`
        : 'Gemini returned an empty response'
    };
  }
  try {
    const payload = JSON.parse(text) as AiPayload;
    if (!payload || typeof payload !== 'object') throw new Error('not an object');
    return { ok: true, payload, status: result.status, reason: '' };
  } catch {
    return { ok: false, status: result.status, reason: 'Gemini returned unparseable JSON' };
  }
}

function modelVersionScore(name: string): number {
  const match = name.match(/gemini-(\d+)(?:\.(\d+))?/i);
  const major = match ? Number(match[1]) : 0;
  const minor = match && match[2] ? Number(match[2]) : 0;
  let score = major * 100 + minor;
  if (/-latest$/i.test(name)) score += 30;
  if (/preview|exp|experimental|thinking|image|audio|tts|embedding/i.test(name)) score -= 500;
  return score;
}

/** Ask the provider which flash model this API key may actually call. */
async function discoverModel(apiKey: string, timeoutMs: number, scope: string): Promise<string> {
  const cached = DISCOVERED_MODEL.get(scope);
  if (cached) return cached;
  const url = `${GEMINI_API_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const result = await geminiFetch(url, { method: 'GET' }, Math.min(Math.max(timeoutMs, 3_000), MODEL_DISCOVERY_TIMEOUT_MS));
  if (result.status !== 200) return '';
  try {
    const models: any[] = JSON.parse(result.body)?.models || [];
    const usable = models
      .filter((model) => !Array.isArray(model?.supportedGenerationMethods)
        || model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => String(model?.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    const preferred = usable.filter((name) => /flash/i.test(name) && !/thinking|image|audio|tts|embedding/i.test(name));
    const pool = preferred.length > 0 ? preferred : usable;
    pool.sort((left, right) => modelVersionScore(right) - modelVersionScore(left));
    const best = pool[0] || '';
    // Only a successful discovery is cached, so a transient failure is retried.
    if (best) {
      if (DISCOVERED_MODEL.size >= MODEL_SCOPE_LIMIT) {
        const oldest = DISCOVERED_MODEL.keys().next().value;
        if (oldest !== undefined) DISCOVERED_MODEL.delete(oldest);
      }
      DISCOVERED_MODEL.set(scope, best);
    }
    return best;
  } catch {
    return '';
  }
}

function buildModelCandidates(explicit: string | undefined, discovered: string): string[] {
  return [explicit, process.env.GEMINI_MODEL, discovered, ...DEFAULT_MODELS]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim())
    .filter((value, index, all) => all.indexOf(value) === index);
}

/** Deduplicate warnings (users were seeing the same line twice) and cap the list. */
export function mergeWarnings(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const message = String(raw || '').trim();
      if (!message) continue;
      const key = message.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(message);
    }
  }
  return out.slice(0, 6);
}

function aiFailureWarning(configuredModel: string, failures: string[], apiKeyRejected: boolean): string {
  const headline = apiKeyRejected
    ? 'AI analysis is unavailable because the Gemini API key was rejected.'
    : 'AI analysis is unavailable for this document.';
  const detail = failures.length > 0
    ? ` Attempts: ${failures.slice(0, 3).join('; ')}.`
    : '';
  const hint = configuredModel ? ` Configured model: ${configuredModel}.` : '';
  return `${headline}${detail}${hint} Scope was read with the built-in document parser.`;
}


function aiPrompt(): string {
  return [
    'You are an expert Construction Superintendent and Field Operations Manager for Hays + Sons Complete Restoration.',
    'You receive ONE insurance restoration estimate (Xactimate, Symbility, carrier estimate, contractor bid or pasted scope text).',
    'Turn it into OPERATIONAL FIELD TRADE WORK ORDERS that on-site crews and subcontractors can execute.',
    '',
    'CONVERSION RULES (mandatory):',
    '1. ZERO FINANCIAL DATA. Never output dollar amounts, unit rates (/SF, /LF), material or equipment tax, overhead and profit, depreciation, deductibles or contract totals. Field crews must never see pricing or margins.',
    '2. ZERO INSURANCE CODES. Drop Xactimate category/selector codes (e.g. "FNH MN", "LMN", "DMO", "PNT B2", "WTR").',
    '3. PLAIN-ENGLISH FIELD ACTIONS. Rewrite insurance shorthand into verb-first physical labour instructions in the "instruction" field - e.g. "Msk and prep for paint - tape only" becomes "Apply high-tack painter\'s masking tape along all baseboard and casing perimeters"; "Remove tile floor covering - Additional labor" becomes "Chip away tile down to bare substrate, remove bonded thinset mortar, and grind the surface smooth".',
    '4. PRESERVE QUANTITIES. Keep the exact SF, LF, EA, CY, SY, GAL, HR measurements and room dimensions that the document states so crews can measure, cut and order material.',
    '5. ISOLATE BY TRADE CREW. Put every row under exactly one of these seven crews: "' + SEVEN_CREWS.join('", "') + '".',
    '',
    'GROUNDING RULES (never break):',
    '6. Extract only what is literally present in the document below. Never invent customers, addresses, claim numbers, totals, rooms, quantities or scope rows.',
    '7. Never reuse example values, sample data or values from any other job. If a field is absent, return an empty string or empty array.',
    '8. lineItems must come from the document scope/line-item rows; skip totals, taxes, O&P, permit fees, deductibles and depreciation rows.',
    '9. "trades" must only describe crews and rooms that the document scope actually covers. Instructions may be rewritten for clarity, but they must stay based on scope rows that exist - keep the group to at most 8 rooms and 6 instructions per room.',
    '10. Put credited, omitted or explicitly excluded scope in that trade\'s "exclusions" array so crews know what NOT to perform.',
    '',
    'Return JSON only, matching the requested schema. Empty arrays/strings are correct answers when the document lacks that information.'
  ].join('\n');
}

const AI_STOPWORDS = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'into', 'onto', 'over', 'under', 'per', 'all', 'any', 'new', 'existing', 'area', 'areas', 'item', 'items', 'room', 'rooms', 'each']);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !AI_STOPWORDS.has(token));
}

/** Percentage of a candidate task's meaningful words that appear in the source document. */
function documentSupport(candidate: string, documentTokens: Set<string>): number {
  const tokens = tokenize(candidate);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((token) => documentTokens.has(token)).length;
  return hits / tokens.length;
}

interface AiPayload {
  customerName?: string;
  propertyAddress?: string;
  phone?: string;
  email?: string;
  claimNumber?: string;
  insuranceCarrier?: string;
  adjusterName?: string;
  lossType?: string;
  dateOfLoss?: string;
  unitArea?: string;
  totalEstimate?: string;
  scopeNotes?: string;
  lineItems?: Array<{ description?: string; quantity?: string; unit?: string; room?: string; trade?: string; instruction?: string }>;
  trades?: Array<{
    tradeName?: string;
    scopeSummary?: string;
    safetyProtocols?: string[];
    rooms?: Array<{ roomName?: string; instructions?: string[] }>;
    materials?: string[];
    qualityChecks?: string[];
    exclusions?: string[];
  }>;
}

/**
 * Rewritten field instructions are allowed to differ in wording from the document
 * (that is the point of the conversion), so they are validated by tracing their
 * vocabulary back to the document instead of requiring an exact phrase match.
 */
function isGroundedInstruction(text: string, documentTokens: Set<string>): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((token) => documentTokens.has(token)).length;
  return hits >= 2 && hits / tokens.length >= 0.2;
}

function cleanFieldText(value: unknown, maxLength = 300): string {
  const text = sanitizeFieldScope(String(value ?? '').replace(/\s+/g, ' ').trim());
  return text.length >= 3 ? text.slice(0, maxLength) : '';
}

function normalizeTradeName(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (!text) return '';
  return [...SEVEN_CREWS, GENERAL_TRADE].find((crew) => {
    const crewWords = crew.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((word) => word.length > 3);
    return crewWords.some((word) => text.includes(word));
  }) || '';
}

function cleanCheckList(value: unknown, documentTokens: Set<string>, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanFieldText(entry);
    if (!text || !isGroundedInstruction(text, documentTokens)) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Overlay the model's field instructions on the deterministic package. Only
 * crews, rooms and wording that trace back to the document are accepted, so the
 * conversion cannot invent work for a crew that the estimate never covered.
 */
function mergeFieldPackage(
  base: FieldWorkOrderSection[],
  incoming: AiPayload['trades'],
  documentTokens: Set<string>
): { sections: FieldWorkOrderSection[]; accepted: number; rejected: number } {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return { sections: base, accepted: 0, rejected: 0 };
  }

  const sections = base.map((section) => ({
    ...section,
    rooms: section.rooms.map((room) => ({ roomName: room.roomName, instructions: [...room.instructions] }))
  }));
  let accepted = 0;
  let rejected = 0;

  for (const group of incoming) {
    const tradeName = normalizeTradeName(group?.tradeName);
    if (!tradeName) continue;
    const section = sections.find((entry) => entry.tradeName === tradeName);
    if (!section) continue;

    const deterministicLimit = Math.max(6, section.rooms.reduce((sum, room) => sum + room.instructions.length, 0) * 2);
    let acceptedHere = 0;

    for (const room of Array.isArray(group?.rooms) ? group.rooms : []) {
      const roomName = String(room?.roomName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!roomName) continue;
      const target = section.rooms.find((entry) => entry.roomName.toLowerCase() === roomName.toLowerCase())
        || section.rooms.find((entry) => entry.roomName === 'General')
        || (() => {
          const created = { roomName, instructions: [] as string[] };
          section.rooms.push(created);
          return created;
        })();
      for (const raw of Array.isArray(room?.instructions) ? room.instructions : []) {
        const text = cleanFieldText(raw);
        if (!text || !isGroundedInstruction(text, documentTokens)) {
          rejected++;
          continue;
        }
        if (acceptedHere >= deterministicLimit) {
          rejected++;
          continue;
        }
        if (!target.instructions.includes(text)) {
          target.instructions.push(text);
          accepted++;
          acceptedHere++;
        }
      }
      target.instructions = target.instructions.slice(0, 8);
    }

    const scopeSummary = cleanFieldText(group?.scopeSummary, 240);
    if (scopeSummary && isGroundedInstruction(scopeSummary, documentTokens)) section.scopeSummary = scopeSummary;
    section.safetyProtocols = [...new Set([...section.safetyProtocols, ...cleanCheckList(group?.safetyProtocols, documentTokens)])].slice(0, 5);
    section.materials = [...new Set([...section.materials, ...cleanCheckList(group?.materials, documentTokens, 8)])].slice(0, 8);
    section.qualityChecks = [...new Set([...section.qualityChecks, ...cleanCheckList(group?.qualityChecks, documentTokens)])].slice(0, 6);
    section.exclusions = [...new Set([...section.exclusions, ...cleanCheckList(group?.exclusions, documentTokens, 6)])].slice(0, 8);
  }

  return { sections, accepted, rejected };
}

/**
 * Ask Gemini to read the document, then validate every returned value against
 * the document itself. Values and line items that cannot be traced back to the
 * document are discarded, so the model cannot introduce fake scope.
 */
export async function enrichEstimateWithAi(
  base: EstimateExtraction,
  options: { text: string; pdfBase64?: string; mimeType?: string; apiKey?: string; model?: string; timeoutMs?: number }
): Promise<AiEnrichmentResult> {
  const warnings: string[] = [];
  const apiKey = (options.apiKey || '').trim();
  if (!apiKey) {
    return { extraction: base, usedAi: false, method: base.extractionMethod, warnings };
  }
  if (!options.text && !options.pdfBase64) {
    return { extraction: base, usedAi: false, method: base.extractionMethod, warnings };
  }

  const configuredTimeout = options.timeoutMs ?? Number(process.env.AI_EXTRACT_TIMEOUT_MS);
  const timeoutMs = Math.min(Math.max(configuredTimeout || DEFAULT_TIMEOUT_MS, 5_000), 55_000);
  // Messages always name the model the deployment was configured for, not the
  // last fallback we happened to try.
  const configuredModel = (options.model || process.env.GEMINI_MODEL || '').trim() || DEFAULT_MODELS[0];
  // A model this key discovered earlier is tried first, so warm instances skip the
  // names Google has already refused for it.
  const scope = modelScope(apiKey);
  const candidates = buildModelCandidates(options.model, DISCOVERED_MODEL.get(scope) || '');

  const contents: unknown[] = [];
  if (options.pdfBase64) {
    contents.push({ inlineData: { mimeType: options.mimeType || 'application/pdf', data: options.pdfBase64 } });
  }
  if (options.text) {
    contents.push({ text: `--- ESTIMATE DOCUMENT START ---\n${options.text.slice(0, 120_000)}\n--- ESTIMATE DOCUMENT END ---` });
  }
  contents.push({ text: aiPrompt() });

  const startedAt = Date.now();
  const failures: string[] = [];
  const outcome: { payload: AiPayload | null; model: string } = { payload: null, model: '' };
  let apiKeyRejected = false;
  const retired = retiredModelsFor(scope);

  const attemptModel = async (model: string): Promise<void> => {
    const attempt = await requestExtraction(model, apiKey, contents, timeoutMs);
    if (attempt.ok && attempt.payload) {
      outcome.payload = attempt.payload;
      outcome.model = model;
      return;
    }
    if (attempt.status === 404) {
      retired.add(model);
      failures.push(`${model}: model not available for this API key`);
      return;
    }
    if (attempt.status === 401 || /API key/i.test(attempt.reason)) {
      apiKeyRejected = true;
    }
    failures.push(`${model}: ${attempt.reason}`);
  };

  for (const model of candidates) {
    if (Date.now() - startedAt > TOTAL_AI_BUDGET_MS) {
      failures.push('AI request budget exhausted');
      break;
    }
    if (retired.has(model)) continue;
    await attemptModel(model);
    if (outcome.payload || apiKeyRejected) break;
  }

  // Every configured name was rejected - ask the key itself which models it may call.
  if (!outcome.payload && !apiKeyRejected) {
    const discovered = await discoverModel(apiKey, timeoutMs, scope);
    if (discovered && !candidates.includes(discovered) && !retired.has(discovered)) {
      await attemptModel(discovered);
    }
  }

  if (!outcome.payload) {
    const summary = aiFailureWarning(configuredModel, failures, apiKeyRejected);
    return {
      extraction: { ...base, warnings: mergeWarnings(base.warnings, [summary]) },
      usedAi: false,
      method: base.extractionMethod,
      warnings: [summary]
    };
  }

  const payload = outcome.payload;
  const usedModel = outcome.model;

  const documentTokens = new Set(tokenize(options.text || ''));
  const merged: EstimateExtraction = { ...base, warnings: [...base.warnings] };
  let rejectedItems = 0;

  const acceptField = (incoming: string | undefined, current: string, validator?: (value: string) => boolean): string => {
    const value = (incoming || '').trim();
    if (!value) return current;
    if (validator && !validator(value)) return current;
    return current || value;
  };

  merged.customerName = acceptField(payload.customerName, base.customerName, isPlausiblePersonName);
  merged.propertyAddress = acceptField(payload.propertyAddress, base.propertyAddress, isPlausibleAddress);
  merged.phone = mergePhone(base.phone, payload.phone);
  merged.email = acceptField(payload.email, base.email, (value) => EMAIL_RE.test(value));
  merged.claimNumber = acceptField(payload.claimNumber, base.claimNumber, (value) => /[A-Za-z0-9]{4,}/.test(value) && /\d/.test(value));
  merged.insuranceCarrier = acceptField(payload.insuranceCarrier, base.insuranceCarrier);
  merged.adjusterName = acceptField(payload.adjusterName, base.adjusterName, isPlausiblePersonName);
  merged.lossType = payload.lossType && payload.lossType.trim().length > 2 ? titleCaseName(payload.lossType.trim()) : base.lossType;
  merged.dateOfLoss = mergeDate(base.dateOfLoss, payload.dateOfLoss);
  merged.unitArea = mergeUnitArea(base.unitArea, payload.unitArea);
  merged.totalEstimate = mergeTotal(base.totalEstimate, payload.totalEstimate);
  if (payload.scopeNotes && payload.scopeNotes.trim().length > 3) {
    merged.notes = `${base.notes} ${payload.scopeNotes.trim()}`.slice(0, 900);
  }

  const trustedAiLines: ScopeLine[] = [];
  const aiInstructions = new Map<string, string>();
  for (const item of payload.lineItems || []) {
    const description = cleanLineDescription(String(item?.description || ''));
    if (description.length < 4 || description.replace(/[^A-Za-z]/g, '').length < 4) continue;
    const support = documentSupport(description, documentTokens);
    const hasQuantity = Boolean(item?.quantity);
    if (support < 0.5 && !(hasQuantity && support >= 0.34)) {
      rejectedItems++;
      continue;
    }
    const cleaned: ScopeLine = {
      description: description.slice(0, 240),
      quantity: String(item?.quantity || '').trim().slice(0, 24),
      unit: String(item?.unit || '').trim().toUpperCase().slice(0, 12),
      room: String(item?.room || '').trim().slice(0, 60)
    };
    trustedAiLines.push(cleaned);

    // A rewritten field instruction is only kept when it traces back to the
    // document, otherwise the deterministic conversion is used.
    const instruction = cleanFieldText(item?.instruction);
    if (instruction && isGroundedInstruction(instruction, documentTokens)) {
      aiInstructions.set(scopeLineKey(cleaned), instruction);
    }
  }

  if (rejectedItems > 0) {
    warnings.push(`Discarded ${rejectedItems} AI line item${rejectedItems === 1 ? '' : 's'} that could not be traced back to the document.`);
  }

  // Merge document-parsed rows with validated AI rows (document rows win).
  const mergedLines: ScopeLine[] = [...uniqueByKey(base.lineItems.map(toScopeLine))];
  for (const line of trustedAiLines) {
    const key = scopeLineKey(line);
    if (!mergedLines.some((existing) => scopeLineKey(existing) === key)) mergedLines.push(line);
  }

  const { groups, lineItems } = mapLinesToTrades(mergedLines.slice(0, 80));
  for (const item of lineItems) {
    item.instruction = aiInstructions.get(scopeLineKey(item))
      || buildFieldInstruction(item.description, item.quantity, item.unit, item.trade);
  }
  merged.lineItems = lineItems;
  merged.tradeBreakdown = groups;
  merged.tasks = mergedLines
    .slice(0, 80)
    .map((line) => (line.quantity ? `${line.description} (${line.quantity}${line.unit ? ` ${line.unit}` : ''})` : line.description));

  const deterministicPackage = buildFieldPackage(lineItems, base.fieldPackage.flatMap((section) =>
    section.exclusions.map((description) => ({ description, trade: section.tradeName }))
  ));
  const packageResult = mergeFieldPackage(deterministicPackage, payload.trades, documentTokens);
  merged.fieldPackage = packageResult.sections;
  if (packageResult.accepted > 0) {
    warnings.push(`AI converted ${packageResult.accepted} scope row${packageResult.accepted === 1 ? '' : 's'} into field crew instructions.`);
  }
  if (packageResult.rejected > 0) {
    warnings.push(`Ignored ${packageResult.rejected} AI field instruction${packageResult.rejected === 1 ? '' : 's'} that could not be traced back to the document.`);
  }

  merged.roomBreakdown = buildRoomBreakdown(mergedLines, base.roomBreakdown);
  merged.suggestedTrade = merged.tradeBreakdown
    .filter((group) => group.tradeName !== GENERAL_TRADE)
    .sort((a, b) => b.tasks.length - a.tasks.length)[0]?.tradeName
    || merged.tradeBreakdown[0]?.tradeName
    || base.suggestedTrade;
  merged.unitArea = merged.unitArea || (merged.roomBreakdown.length > 0 ? merged.roomBreakdown.slice(0, 4).map((room) => room.roomName).join(', ') : base.unitArea);

  const hasNewInformation = merged.customerName !== base.customerName
    || merged.propertyAddress !== base.propertyAddress
    || merged.claimNumber !== base.claimNumber
    || merged.tasks.length > base.tasks.length;
  merged.confidence = Math.min(1, Number((base.confidence + (hasNewInformation ? 0.12 : 0.06)).toFixed(3)));
  merged.extractionMethod = `gemini:${usedModel}`;
  merged.warnings = mergeWarnings(merged.warnings, warnings);
  merged.demoTemplatesSuppressed = base.demoTemplatesSuppressed;
  merged.projectName = merged.customerName
    ? `${merged.customerName} - ${merged.lossType}`
    : merged.propertyAddress
      ? `${merged.propertyAddress} - ${merged.lossType}`
      : base.projectName;

  return { extraction: merged, usedAi: true, method: merged.extractionMethod, warnings };
}

function toScopeLine(item: ExtractedLineItem): ScopeLine {
  return { description: item.description, quantity: item.quantity, unit: item.unit, room: item.room };
}

function uniqueByKey(lines: ScopeLine[]): ScopeLine[] {
  const seen = new Set<string>();
  const out: ScopeLine[] = [];
  for (const line of lines) {
    const key = scopeLineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function buildRoomBreakdown(lines: ScopeLine[], fallback: ExtractedRoomGroup[]): ExtractedRoomGroup[] {
  const rooms = new Map<string, string[]>();
  for (const line of lines) {
    if (!line.room) continue;
    if (!rooms.has(line.room)) rooms.set(line.room, []);
    rooms.get(line.room)!.push(line.description);
  }
  if (rooms.size === 0) return fallback;
  return [...rooms.entries()].map(([roomName, tasks]) => ({ roomName, tasks }));
}

function mergePhone(current: string, incoming?: string): string {
  if (current) return current;
  const normalized = normalizePhone(String(incoming || ''));
  return normalized && isPlausiblePhone(normalized) ? normalized : '';
}

function mergeDate(current: string, incoming?: string): string {
  if (current) return current;
  return parseIsoDate(String(incoming || ''));
}

function mergeUnitArea(current: string, incoming?: string): string {
  if (current) return current;
  const value = String(incoming || '').trim();
  return value.length >= 2 && value.length <= 80 ? value : '';
}

function mergeTotal(current: string, incoming?: string): string {
  if (current) return current;
  const match = String(incoming || '').match(MONEY_RE);
  if (!match) return '';
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 100 || value > 5_000_000) return '';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR
// ---------------------------------------------------------------------------

function decodeBase64Payload(value: string): string {
  const clean = value.includes('base64,') ? value.split('base64,')[1] : value;
  return clean.replace(/\s+/g, '');
}

/**
 * Full pipeline: PDF or pasted text -> normalised document -> deterministic
 * extraction -> optional validated AI enrichment.
 */
export async function extractEstimate(options: ExtractEstimateOptions): Promise<EstimateExtraction> {
  const warnings: string[] = [];
  const pastedText = (options.textSnippet || '').trim();
  const base64Payload = decodeBase64Payload(options.pdfBase64 || '');
  const mimeType = (options.mimeType || '').toLowerCase();

  let pdfText = '';
  let documentStats: DocumentStats = {
    characters: pastedText.length,
    pages: 1,
    hasTextLayer: pastedText.length > 0,
    lookedLikeScan: false
  };
  let source: EstimateSource = 'text';
  let inlinePdfForAi: string | undefined;
  let inlineMimeForAi: string | undefined;

  if (base64Payload) {
    source = 'pdf';
    try {
      const buffer = Buffer.from(base64Payload, 'base64');
      if (mimeType.includes('pdf') || isPdfBuffer(buffer)) {
        const pdf = extractPdfText(buffer);
        pdfText = pdf.text;
        documentStats = {
          characters: pdf.text.length,
          pages: pdf.pages,
          hasTextLayer: pdf.hasTextLayer,
          lookedLikeScan: pdf.lookedLikeScan
        };
        warnings.push(...pdf.warnings);
        if (!pdf.hasTextLayer) {
          // Hand the original PDF to the multimodal model when the text layer is missing.
          inlinePdfForAi = base64Payload;
          inlineMimeForAi = 'application/pdf';
        }
      } else {
        // Client sent a text file as base64.
        const decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
        pdfText = decoded;
        documentStats = { characters: decoded.length, pages: 1, hasTextLayer: decoded.length > 0, lookedLikeScan: false };
      }
    } catch (err: any) {
      warnings.push(`The uploaded file could not be read: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  const combined = [pastedText, pdfText].filter(Boolean).join('\n').trim();
  const sourceHash = hashSourceText(normalizeDocumentText(combined) || base64Payload.slice(0, 20_000));

  const extraction = parseEstimateText(combined, {
    fileName: options.fileName,
    source,
    documentStats,
    baseWarnings: warnings,
    sourceHash,
    rawCharacters: combined.length
  });

  if (!combined) {
    extraction.warnings = mergeWarnings([
      ...extraction.warnings,
      'No readable text was found in the submitted document. Paste the estimate text so the scope can be read.'
    ]);
    return extraction;
  }

  const apiKey = (options.apiKey || '').trim();
  if (!apiKey) {
    extraction.warnings = mergeWarnings([
      ...extraction.warnings,
      'AI analysis is not configured (GEMINI_API_KEY missing) - using the built-in deterministic parser.'
    ]);
    return extraction;
  }

  const enriched = await enrichEstimateWithAi(extraction, {
    text: combined,
    pdfBase64: inlinePdfForAi,
    mimeType: inlineMimeForAi,
    apiKey,
    model: options.model,
    timeoutMs: options.timeoutMs
  });

  return { ...enriched.extraction, warnings: mergeWarnings(enriched.extraction.warnings) };
}
