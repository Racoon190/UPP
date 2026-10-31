#!/usr/bin/env node
/**
 * Sheet Toolkit runtime (UPP productivity plugin, zero dependencies).
 *
 * Reads local .xlsx (ZIP + XML, read directly) and .csv (RFC4180) files,
 * profiles them, cleans dirty rows, and produces grouped aggregates. Every
 * step runs inside this process: the plugin has no network permission and
 * never uploads a file. Outputs are hard-capped so one call stays small.
 *
 * Dual mode (identical handlers on both channels):
 *   - MCP stdio server : node server.mjs
 *   - CLI              : node server.mjs --cli <tool> --json '{...}'
 *   - introspection    : node server.mjs --info | --list
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(resolve(HERE, 'tools.json'), 'utf8'));
const SERVER_NAME = MANIFEST.serverName;
const SERVER_VERSION = MANIFEST.version;
const HOST = process.env.UPP_HOST || 'unknown';
const CHANNEL = process.argv[2] === '--cli' ? 'cli' : 'mcp';

const MAX_CELL_CHARS = 80;
const MAX_COLUMNS = 40;
const ROWS_BUDGET_BYTES = 5000;
const AGGS = ['sum', 'avg', 'min', 'max', 'count'];

function log(...args) {
  process.stderr.write(`[upp:${SERVER_NAME}] ${args.join(' ')}\n`);
}

class UppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ zip
/** Read a ZIP container without dependencies (xlsx is ZIP + XML). */
function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new UppError('INVALID_ARGS', 'file is not a ZIP container (xlsx expected)');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < total; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (localOff + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + csize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
  }
  return entries;
}

function findEocd(buf) {
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&amp;/g, '&');
}

// ------------------------------------------------------------------ xlsx
/**
 * A numeric cell carrying a style (s="N") is treated as a date-formatted cell:
 * styles.xml is deliberately not resolved, the cached value is kept as an ISO
 * date string when it is a plausible Excel serial.
 */
function serialToIso(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

function parseCell(attrs, inner, shared) {
  const type = /(?:^|\s)t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
  const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (type === 's') {
    const text = shared[Number(rawValue ?? -1)];
    return { value: text ?? '', kind: text === undefined ? 'empty' : 'string' };
  }
  if (type === 'inlineStr') {
    const text = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
    return { value: text, kind: text === '' ? 'empty' : 'string' };
  }
  if (type === 'str') return { value: decodeXml(rawValue ?? ''), kind: rawValue === undefined ? 'empty' : 'string' };
  if (type === 'd') {
    const text = decodeXml(rawValue ?? '');
    return { value: text.slice(0, 10), kind: text ? 'date' : 'empty' };
  }
  if (type === 'b') return { value: rawValue === '1' ? 'TRUE' : 'FALSE', kind: 'string' };
  const text = decodeXml(rawValue ?? '');
  if (text === '') return { value: '', kind: 'empty' };
  if (/(?:^|\s)s="/.test(attrs)) {
    const iso = serialToIso(text);
    if (iso) return { value: iso, kind: 'date' };
  }
  return { value: text, kind: 'number' };
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf) {
  const zip = readZip(buf);
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  // Relationship attributes may appear in any order (Type -> Target -> Id in
  // the wild), so match the whole tag first and then pull each attribute.
  const relMap = new Map();
  for (const rel of (zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '').matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) relMap.set(id, target);
  }
  const shared = [];
  for (const si of (zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeXml([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  const activeTab = Number(/\bactiveTab="(\d+)"/.exec(workbook)?.[1] ?? 0);
  const sheets = [];
  for (const tag of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = tag[1];
    const name = decodeXml(/\bname="([^"]+)"/.exec(attrs)?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    let target = (relMap.get(rid) ?? '').replace(/^\/?xl\//, '').replace(/^\//, '');
    if (!target.startsWith('worksheets/')) target = 'worksheets/' + basename(target);
    const xml = zip.get('xl/' + target)?.toString('utf8') ?? '';
    if (!xml) continue;
    const rows = [];
    for (const rowTag of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellTag of rowTag[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrsCell = cellTag[1] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrsCell)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        cells[col] = parseCell(attrsCell, cellTag[2] ?? '', shared);
      }
      rows.push(Array.from(cells, (cell) => cell ?? { value: '', kind: 'empty' }));
    }
    sheets.push({ name, active: false, rows });
  }
  if (sheets[activeTab]) sheets[activeTab].active = true;
  else if (sheets[0]) sheets[0].active = true;
  return sheets;
}

// ------------------------------------------------------------------ csv
/** Minimal RFC4180 parser: quotes, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function toNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const cleaned = text.replace(/[,\s¥$€£%]/g, '');
  if (!NUMERIC.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function csvSheet(filePath, text) {
  const rows = parseCsv(text).map((row) =>
    row.map((raw) => {
      const value = String(raw ?? '');
      const trimmed = value.trim();
      const kind = !trimmed ? 'empty' : ISO_DATE.test(trimmed) ? 'date' : toNumber(trimmed) === null ? 'string' : 'number';
      return { value, kind };
    }),
  );
  return { name: basename(filePath), active: true, rows };
}

// ------------------------------------------------------- sheet model helpers
function resolveFile(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new UppError('INVALID_ARGS', 'path must be a non-empty string');
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw new UppError('NOT_FOUND', `file not found: ${path}`);
  return { path, size: info.size };
}

function loadSheet(rawPath, sheetName) {
  const file = resolveFile(rawPath);
  const buf = readFileSync(file.path);
  const ext = extname(file.path).toLowerCase();
  let sheets;
  if (ext === '.xlsx' || ext === '.xlsm') sheets = readXlsx(buf);
  else if (ext === '.csv') sheets = [csvSheet(file.path, buf.toString('utf8'))];
  else throw new UppError('INVALID_ARGS', `unsupported file type: ${ext || '(none)'} (xlsx/csv)`);
  const wanted = typeof sheetName === 'string' && sheetName !== '' ? sheetName : null;
  const sheet = wanted ? sheets.find((s) => s.name === wanted) : sheets.find((s) => s.active) ?? sheets[0];
  if (!sheet) throw new UppError('NOT_FOUND', `sheet not found: ${wanted}`);
  return { file, sheets, sheet };
}

function sheetWidth(sheet) {
  let width = 0;
  for (const row of sheet.rows) width = Math.max(width, row.length);
  return width;
}

function cellAt(row, index) {
  return row?.[index] ?? { value: '', kind: 'empty' };
}

function dataRows(sheet, width) {
  return sheet.rows.slice(1).map((row) => Array.from({ length: width }, (_, i) => cellAt(row, i)));
}

function headerNames(sheet, width, trim) {
  const first = sheet.rows[0] ?? [];
  const names = [];
  for (let i = 0; i < width; i += 1) {
    const raw = String(cellAt(first, i).value ?? '');
    const name = trim ? raw.trim() : raw;
    names.push(name || `Column${i + 1}`);
  }
  return names;
}

function columnType(kinds) {
  if (!kinds.length) return 'empty';
  let dates = 0;
  let numbers = 0;
  for (const kind of kinds) {
    if (kind === 'date') dates += 1;
    else if (kind === 'number') numbers += 1;
  }
  if (dates > 0 && dates >= kinds.length * 0.6) return 'date';
  if (numbers >= kinds.length * 0.6) return 'number';
  return 'string';
}

function columnStats(sheet, width) {
  const rows = dataRows(sheet, width);
  return headerNames(sheet, width, true).map((name, index) => {
    const seen = new Set();
    const kinds = [];
    let nonEmpty = 0;
    let duplicates = 0;
    for (const row of rows) {
      const cell = row[index];
      const trimmed = String(cell.value ?? '').trim();
      if (!trimmed) continue;
      nonEmpty += 1;
      if (seen.has(trimmed)) duplicates += 1;
      else seen.add(trimmed);
      kinds.push(cell.kind === 'empty' ? 'string' : cell.kind);
    }
    return { name, type: columnType(kinds), nonEmpty, duplicates };
  });
}

// ------------------------------------------------------------ output guards
function clip(value) {
  const text = String(value ?? '');
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text;
}

/** Hard cap: row count, column count and serialized bytes (whichever hits first). */
function capRows(rows, limit) {
  const out = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows) {
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (out.length && bytes + size > ROWS_BUDGET_BYTES) {
      truncated = true;
      break;
    }
    out.push(row);
    bytes += size;
  }
  return { rows: out, truncated };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// ------------------------------------------------------------------ handlers
const HANDLERS = {
  sheet_profile(args) {
    const sampleLimit = args.sampleRows ?? 5;
    const { file, sheets, sheet } = loadSheet(args.path, args.sheet);
    const width = sheetWidth(sheet);
    const shownWidth = Math.min(width, MAX_COLUMNS);
    const sample = [];
    for (const row of sheet.rows.slice(1)) {
      const out = [];
      for (let i = 0; i < shownWidth; i += 1) out.push(clip(cellAt(row, i).value));
      sample.push(out);
    }
    const capped = capRows(sample, sampleLimit);
    const data = {
      file: file.path,
      sheets: sheets.map((entry) => entry.name),
      activeSheet: sheet.name,
      rows: Math.max(sheet.rows.length - 1, 0),
      cols: width,
      columns: columnStats(sheet, width).slice(0, MAX_COLUMNS),
      sampleRows: capped.rows,
    };
    if (capped.truncated || width > MAX_COLUMNS) data.truncated = true;
    return data;
  },

  sheet_clean(args) {
    const maxRows = args.maxRows ?? 20;
    const doTrim = args.trim !== false;
    const dropEmptyRows = args.dropEmptyRows !== false;
    const dropDuplicates = args.dropDuplicates !== false;
    const { file, sheet } = loadSheet(args.path, args.sheet);
    const width = sheetWidth(sheet);
    const before = Math.max(sheet.rows.length - 1, 0);
    let trimmedCells = 0;
    let rows = dataRows(sheet, width).map((row) =>
      row.map((cell) => {
        const raw = String(cell.value ?? '');
        if (!doTrim) return raw;
        const trimmed = raw.trim();
        if (trimmed !== raw) trimmedCells += 1;
        return trimmed;
      }),
    );
    let removedEmpty = 0;
    if (dropEmptyRows) {
      const kept = rows.filter((row) => row.some((value) => value.trim() !== ''));
      removedEmpty = rows.length - kept.length;
      rows = kept;
    }
    let removedDuplicate = 0;
    if (dropDuplicates) {
      const seen = new Set();
      const kept = [];
      for (const row of rows) {
        const key = JSON.stringify(row);
        if (seen.has(key)) {
          removedDuplicate += 1;
          continue;
        }
        seen.add(key);
        kept.push(row);
      }
      rows = kept;
    }
    const capped = capRows(
      rows.map((row) => row.slice(0, MAX_COLUMNS).map(clip)),
      maxRows,
    );
    const data = {
      file: file.path,
      sheet: sheet.name,
      before,
      after: rows.length,
      removedEmpty,
      removedDuplicate,
      trimmedCells,
      columns: headerNames(sheet, width, doTrim).slice(0, MAX_COLUMNS),
      rows: capped.rows,
    };
    if (capped.truncated || width > MAX_COLUMNS) data.truncated = true;
    return data;
  },

  sheet_summary(args) {
    const topN = args.topN ?? 10;
    const aggs = [...new Set(args.aggs ?? AGGS)];
    const badAgg = aggs.find((agg) => !AGGS.includes(agg));
    if (badAgg) throw new UppError('INVALID_ARGS', `unsupported aggregation: ${badAgg} (${AGGS.join('/')})`);
    const { file, sheet } = loadSheet(args.path, args.sheet);
    const width = sheetWidth(sheet);
    const header = headerNames(sheet, width, true);
    const columnIndex = (name) => header.findIndex((entry) => entry === String(name).trim());
    const groupIndex = columnIndex(args.groupBy);
    if (groupIndex < 0) throw new UppError('NOT_FOUND', `column not found: ${args.groupBy}`);
    const valueColumns = args.values.map((name) => {
      const index = columnIndex(name);
      if (index < 0) throw new UppError('NOT_FOUND', `column not found: ${name}`);
      return { name: header[index], index };
    });
    const rows = dataRows(sheet, width);
    const groups = new Map();
    for (const row of rows) {
      const key = String(cellAt(row, groupIndex).value ?? '').trim();
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const numbersFor = (groupRows, index) => groupRows.map((row) => toNumber(cellAt(row, index).value)).filter((value) => value !== null);
    const aggregate = (numbers, agg) => {
      if (agg === 'count') return numbers.length;
      if (!numbers.length) return agg === 'sum' ? 0 : null;
      if (agg === 'sum') return round6(numbers.reduce((total, value) => total + value, 0));
      if (agg === 'avg') return round6(numbers.reduce((total, value) => total + value, 0) / numbers.length);
      if (agg === 'min') return Math.min(...numbers);
      return Math.max(...numbers);
    };
    const labels = ['group'];
    for (const value of valueColumns) for (const agg of aggs) labels.push(`${value.name}.${agg}`);
    const sorted = [...groups.entries()]
      .map(([key, groupRows]) => {
        const cells = [];
        for (const value of valueColumns) {
          const numbers = numbersFor(groupRows, value.index);
          for (const agg of aggs) cells.push(aggregate(numbers, agg));
        }
        return { key, cells, weight: valueColumns.length ? aggregate(numbersFor(groupRows, valueColumns[0].index), 'sum') : 0 };
      })
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const allNumbers = new Map();
    for (const value of valueColumns) allNumbers.set(value.name, numbersFor(rows, value.index));
    const totals = {};
    for (const value of valueColumns) {
      for (const agg of aggs) totals[`${value.name}.${agg}`] = aggregate(allNumbers.get(value.name), agg);
    }
    const capped = capRows(
      sorted.slice(0, topN).map((entry) => [entry.key, ...entry.cells]),
      topN,
    );
    const data = {
      file: file.path,
      sheet: sheet.name,
      groupBy: header[groupIndex],
      values: valueColumns.map((value) => value.name),
      aggs,
      labels,
      rows: capped.rows,
      totals,
      groups: sorted.length,
    };
    if (capped.truncated || capped.rows.length < sorted.length) data.truncated = true;
    return data;
  },
};

// ------------------------------------------------------------------ schema
/** Minimal schema-driven validation so every channel rejects the same inputs. */
function validate(tool, args) {
  const schema = tool.inputSchema ?? {};
  const value = args ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UppError('INVALID_ARGS', 'arguments must be a JSON object');
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) throw new UppError('INVALID_ARGS', `missing required argument: ${key}`);
  }
  const props = schema.properties ?? {};
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(value, key)) continue;
    const expected = spec?.type;
    if (expected === 'integer') {
      if (!Number.isInteger(value[key])) throw new UppError('INVALID_ARGS', `${key} must be an integer`);
      if (Number.isFinite(spec.minimum) && value[key] < spec.minimum) throw new UppError('INVALID_ARGS', `${key} must be >= ${spec.minimum}`);
      if (Number.isFinite(spec.maximum) && value[key] > spec.maximum) throw new UppError('INVALID_ARGS', `${key} must be <= ${spec.maximum}`);
      continue;
    }
    if (expected === 'array') {
      if (!Array.isArray(value[key])) throw new UppError('INVALID_ARGS', `${key} must be an array`);
      if (Number.isFinite(spec.minItems) && value[key].length < spec.minItems) throw new UppError('INVALID_ARGS', `${key} needs at least ${spec.minItems} item(s)`);
      if (Number.isFinite(spec.maxItems) && value[key].length > spec.maxItems) throw new UppError('INVALID_ARGS', `${key} allows at most ${spec.maxItems} item(s)`);
      for (const item of value[key]) {
        if (spec.items?.type && typeof item !== spec.items.type) throw new UppError('INVALID_ARGS', `${key} items must be ${spec.items.type}`);
        if (Array.isArray(spec.items?.enum) && !spec.items.enum.includes(item)) throw new UppError('INVALID_ARGS', `${key} has unsupported value: ${item}`);
      }
      continue;
    }
    const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
    if (expected && expected !== actual) throw new UppError('INVALID_ARGS', `${key} must be ${expected}`);
    if (Array.isArray(spec.enum) && !spec.enum.includes(value[key])) throw new UppError('INVALID_ARGS', `${key} has unsupported value: ${value[key]}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(props, key)) throw new UppError('INVALID_ARGS', `unknown argument: ${key}`);
    }
  }
  return value;
}

function callTool(name, args) {
  const tool = MANIFEST.tools.find((entry) => entry.name === name);
  if (!tool) throw new UppError('NOT_FOUND', `unknown tool: ${name}`);
  const clean = validate(tool, args ?? {});
  const started = Date.now();
  const data = HANDLERS[name](clean) ?? {};
  return { ok: true, data, channel: CHANNEL, host: HOST, elapsedMs: Date.now() - started };
}

function errorEnvelope(error) {
  return { ok: false, code: error?.code ?? 'INTERNAL', message: error?.message ?? String(error), channel: CHANNEL, host: HOST, elapsedMs: 0 };
}

function toolList() {
  return MANIFEST.tools.map((entry) => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }));
}

function printJSON(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------- CLI mode
function cliArgs(argv) {
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx > -1) {
    try {
      return JSON.parse(argv[jsonIdx + 1] ?? '{}');
    } catch (error) {
      throw new UppError('INVALID_ARGS', `invalid --json: ${error.message}`);
    }
  }
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    }
  }
  return out;
}

const argv = process.argv.slice(2);
if (argv[0] === '--info') {
  printJSON({ id: SERVER_NAME, version: SERVER_VERSION, host: HOST, tools: toolList().map((tool) => tool.name) });
  process.exit(0);
}
if (argv[0] === '--list') {
  printJSON(toolList());
  process.exit(0);
}
if (argv[0] === '--cli') {
  const name = argv[1];
  if (!name) {
    printJSON(errorEnvelope(new UppError('INVALID_ARGS', 'usage: --cli <tool> [--json <object>]')));
    process.exit(2);
  }
  try {
    printJSON({ ...callTool(name, cliArgs(argv.slice(2))), tool: name });
    process.exit(0);
  } catch (error) {
    printJSON(errorEnvelope(error));
    process.exit(error?.code === 'INTERNAL' ? 1 : 2);
  }
}

// ------------------------------------------------------- MCP stdio server
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (error) {
    log('ignored non-JSON line:', error.message);
    return;
  }
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Local spreadsheet toolkit. Call sheet_profile first, then sheet_clean or sheet_summary. Envelope: {ok, data, channel, host, elapsedMs}.',
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: toolList() });
        return;
      case 'tools/call': {
        const { name, arguments: args } = params ?? {};
        try {
          reply(id, { content: [{ type: 'text', text: JSON.stringify(callTool(name, args)) }], isError: false });
        } catch (error) {
          reply(id, { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(error)) }], isError: true });
        }
        return;
      }
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'resources/templates/list':
        reply(id, { resourceTemplates: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        if (isNotification) return;
        replyError(id, -32601, `method not found: ${String(method)}`);
    }
  } catch (error) {
    if (!isNotification) replyError(id, -32603, `internal error: ${error.message}`);
    log('handler error:', error.message);
  }
});

rl.on('close', () => process.exit(0));
log('ready on stdio');
