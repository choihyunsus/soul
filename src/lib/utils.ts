// Soul v9.0 — Shared utility functions (file I/O, time, security, logging)
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// ── Logging (leveled: debug < info < warn < error) ──

const LOG_LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const _logLevel: number = LOG_LEVELS[process.env.N2_LOG_LEVEL || 'info'] ?? LOG_LEVELS['info'] ?? 1;

function _log(level: string, context: string, msgOrErr: unknown): void {
  if ((LOG_LEVELS[level] ?? 0) < _logLevel) return;
  const msg = msgOrErr instanceof Error ? msgOrErr.message : String(msgOrErr);
  const prefix = `[soul:${context}]`;
  if (level === 'error') console.error(prefix, msg);
  else if (level === 'warn') console.error(prefix, '⚠', msg);
  else console.error(prefix, msg);
}

export function logDebug(context: string, msg: unknown): void { _log('debug', context, msg); }
export function logInfo(context: string, msg: unknown): void { _log('info', context, msg); }
export function logWarn(context: string, msg: unknown): void { _log('warn', context, msg); }
export function logError(context: string, err: unknown): void { _log('error', context, err); }

// ── Timezone ──

let _tz: string | null = null;

function _getTimezone(): string {
  if (!_tz) {
    try {
      // NOTE: require() kept to avoid circular dependency — config imports utils
      const config = require('./config') as { TIMEZONE?: string };
      _tz = process.env.N2_TIMEZONE || config.TIMEZONE || 'Asia/Seoul';
    } catch {
      _tz = process.env.N2_TIMEZONE || 'Asia/Seoul';
    }
  }
  return _tz!;
}

// ── Sync File I/O ──

export function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(filePath: string): T | null {
  const content = readFile(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    logError('readJson', e);
    return null;
  }
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── Async File I/O (for hot-path non-blocking operations) ──

export async function readFileAsync(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('readFileAsync', e);
    }
    return null;
  }
}

export async function readJsonAsync<T = unknown>(filePath: string): Promise<T | null> {
  const content = await readFileAsync(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    logError('readJsonAsync', e);
    return null;
  }
}

export async function writeJsonAsync(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function writeFileAsync(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

// ── Time ──

export function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: _getTimezone() });
}

export function nowISO(): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: _getTimezone(),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value || '00';

  // Compute UTC offset dynamically for the configured timezone
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = now.toLocaleString('en-US', { timeZone: _getTimezone() });
  const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const diffH = Math.floor(Math.abs(diffMs) / 3600000);
  const diffM = Math.floor((Math.abs(diffMs) % 3600000) / 60000);
  const sign = diffMs >= 0 ? '+' : '-';
  const offset = `${sign}${String(diffH).padStart(2, '0')}:${String(diffM).padStart(2, '0')}`;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

// ── Security ──

export function safePath(filePath: string, baseDir: string): string | null {
  const resolved = path.resolve(baseDir, filePath);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    logError('safePath', `Path traversal blocked: ${filePath}`);
    return null;
  }
  return resolved;
}

// ── First-line comment validation ──

export function validateFirstLineComment(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const firstLine = (content.split('\n')[0] ?? '').trim();
    const patterns = [
      /^\/\/\s*.+/,     // JS/TS
      /^#\s*.+/,        // Python/Shell/YAML
      /^<!--\s*.+/,     // HTML/MD
      /^\/\*\s*.+/,     // CSS/Java
      /^\{.*"_desc"/,   // JSON with _desc field
    ];
    return patterns.some(p => p.test(firstLine));
  } catch (e) {
    logError('validateFirstLineComment', e);
    return false;
  }
}
