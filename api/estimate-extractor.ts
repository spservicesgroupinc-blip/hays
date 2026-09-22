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
import { GoogleGenAI, Type } from '@google/genai';

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
    const isSectionLike = /^[A-Z][A-Z /&,'-]{6,}$/.test(description) && !hasAction;
    if (isSectionLike) continue;

    const dimension = description.match(DIMENSION_RE);
    const hasQuantity = Boolean(qtyMatch || dimension);
    // A line with neither a trade action verb nor a measurable quantity is prose
    // (a cover note, an email footer, an adjuster comment) - not a scope item.
    if (!hasAction && !hasQuantity) continue;
    if (!hasQuantity && /[.!?]\s+[A-Z]/.test(description)) continue;
    if (!hasAction && letters.length < 10) continue;

    const quantity = qtyMatch ? qtyMatch.quantity : dimension ? `${dimension[1]}x${dimension[2]}` : '';
    const unit = qtyMatch ? qtyMatch.unit : dimension ? 'FT' : '';

    results.push({
      description: description.slice(0, 240),
      quantity,
      unit,
      room: currentRoom
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
  const seenKeys = new Set<string>();
  for (const line of scopeLines) {
    const key = `${scopeLineKey(line)}|${line.quantity}|${line.unit}`;
    if (key === '|' || seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueScope.push(line);
    if (uniqueScope.length >= 80) break;
  }

  const { groups: tradeBreakdown, lineItems } = mapLinesToTrades(uniqueScope);
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
    confidence,
    warnings,
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

const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const DEFAULT_TIMEOUT_MS = 25_000;

export interface AiEnrichmentResult {
  extraction: EstimateExtraction;
  usedAi: boolean;
  method: string;
  warnings: string[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function aiSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      customerName: { type: Type.STRING },
      propertyAddress: { type: Type.STRING },
      phone: { type: Type.STRING },
      email: { type: Type.STRING },
      claimNumber: { type: Type.STRING },
      insuranceCarrier: { type: Type.STRING },
      adjusterName: { type: Type.STRING },
      lossType: { type: Type.STRING },
      dateOfLoss: { type: Type.STRING },
      unitArea: { type: Type.STRING },
      totalEstimate: { type: Type.STRING },
      lineItems: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            quantity: { type: Type.STRING },
            unit: { type: Type.STRING },
            room: { type: Type.STRING }
          },
          required: ['description']
        }
      },
      scopeNotes: { type: Type.STRING }
    },
    required: ['lineItems']
  } as const;
}

function aiPrompt(): string {
  return [
    'You are a restoration estimating assistant for Hays + Sons Complete Restoration.',
    '',
    'You receive ONE estimate/scope document (Xactimate, Symbility, carrier estimate, contractor bid, or pasted email text).',
    '',
    'ABSOLUTE RULES:',
    '1. Extract only what is literally present in the document below. Never invent customers, addresses, claim numbers, totals, rooms, quantities or line items.',
    '2. Never reuse example values, sample data or values from any other job. If a field is not in the document, return an empty string.',
    '3. lineItems must come from the document scope/line-item rows. Keep the wording used in the document; strip prices but keep measured quantities and units (SF, LF, EA, CY, SY, GAL, HR).',
    '4. Do not add generic "best practice" tasks that the document does not call for, and do not merge unrelated rows together.',
    '5. Include every distinct scope row you can read (up to 60). Skip totals, taxes, O&P, permit fees, deductibles and depreciation rows.',
    '6. Use the same language as the document (do not translate or paraphrase heavily).',
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
  lineItems?: Array<{ description?: string; quantity?: string; unit?: string; room?: string }>;
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
  const models = [options.model, process.env.GEMINI_MODEL, ...DEFAULT_MODELS]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim())
    .filter((value, index, all) => all.indexOf(value) === index);

  const client = new GoogleGenAI({ apiKey });
  let payload: AiPayload | null = null;
  let usedModel = '';

  for (const model of models) {
    try {
      const contents: any[] = [];
      if (options.pdfBase64) {
        contents.push({ inlineData: { mimeType: options.mimeType || 'application/pdf', data: options.pdfBase64 } });
      }
      if (options.text) {
        contents.push({ text: `--- ESTIMATE DOCUMENT START ---\n${options.text.slice(0, 120_000)}\n--- ESTIMATE DOCUMENT END ---` });
      }
      contents.push({ text: aiPrompt() });

      const response: any = await withTimeout(
        client.models.generateContent({
          model,
          contents,
          config: { responseMimeType: 'application/json', responseSchema: aiSchema(), temperature: 0 }
        }),
        timeoutMs,
        `Gemini ${model} extraction`
      );

      const raw = (response?.text || '').trim();
      if (!raw) throw new Error('empty response');
      const parsed = JSON.parse(raw) as AiPayload;
      if (!parsed || typeof parsed !== 'object') throw new Error('unparseable response');
      payload = parsed;
      usedModel = model;
      break;
    } catch (err: any) {
      const message = String(err?.message || err);
      warnings.push(`AI enrichment with ${model} failed: ${message.slice(0, 160)}`);
    }
  }

  if (!payload) {
    return { extraction: { ...base, warnings: [...base.warnings, ...warnings] }, usedAi: false, method: base.extractionMethod, warnings };
  }

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
  for (const item of payload.lineItems || []) {
    const description = cleanLineDescription(String(item?.description || ''));
    if (description.length < 4 || description.replace(/[^A-Za-z]/g, '').length < 4) continue;
    const support = documentSupport(description, documentTokens);
    const hasQuantity = Boolean(item?.quantity);
    if (support < 0.5 && !(hasQuantity && support >= 0.34)) {
      rejectedItems++;
      continue;
    }
    trustedAiLines.push({
      description: description.slice(0, 240),
      quantity: String(item?.quantity || '').trim().slice(0, 24),
      unit: String(item?.unit || '').trim().toUpperCase().slice(0, 12),
      room: String(item?.room || '').trim().slice(0, 60)
    });
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
  merged.lineItems = lineItems;
  merged.tradeBreakdown = groups;
  merged.tasks = mergedLines
    .slice(0, 80)
    .map((line) => (line.quantity ? `${line.description} (${line.quantity}${line.unit ? ` ${line.unit}` : ''})` : line.description));

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
  merged.warnings = [...merged.warnings, ...warnings];
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
    extraction.warnings.push('No readable text was found in the submitted document. Paste the estimate text so the scope can be read.');
    return extraction;
  }

  const apiKey = (options.apiKey || '').trim();
  if (!apiKey) {
    extraction.warnings.push('AI analysis is not configured (GEMINI_API_KEY missing) - using the built-in deterministic parser.');
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

  if (!enriched.usedAi) {
    extraction.warnings.push('AI analysis was unavailable - results come from the built-in deterministic parser.');
  }

  return enriched.extraction;
}
