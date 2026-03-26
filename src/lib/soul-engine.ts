// Soul v9.0 — Soul engine: Board, Ledger, and File Index management.
import fs from 'fs';
import path from 'path';
import { readJson, writeJson, nowISO, logError } from './utils';
import type {
  SoulBoard, BoardState, Handoff, LedgerEntry, FileChange,
  ClaimResult, ProjectInfo, FileIndex, FileEntry, DirectoryEntry,
  FileOwnership, ActiveWork,
} from '../types';

interface BoardCacheEntry {
  board: SoulBoard;
  mtime: number;
}

interface LedgerInputEntry {
  startedAt?: string;
  title?: string;
  filesCreated?: FileChange[];
  filesModified?: FileChange[];
  filesDeleted?: FileChange[];
  decisions?: string[];
  summary?: string;
}

interface ScanOptions {
  maxDepth?: number;
  excludes?: string[];
}

export class SoulEngine {
  private readonly dataDir: string;
  private readonly _boardCache: Map<string, BoardCacheEntry>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this._boardCache = new Map();
  }

  // ── Path helpers ──

  projectDir(projectName: string): string {
    return path.join(this.dataDir, 'projects', projectName);
  }

  boardPath(projectName: string): string {
    return path.join(this.projectDir(projectName), 'soul-board.json');
  }

  fileIndexPath(projectName: string): string {
    return path.join(this.projectDir(projectName), 'file-index.json');
  }

  ledgerDir(projectName: string, date?: string): string {
    const dateParts = (date || nowISO().split('T')[0] || '').split('-');
    const y = dateParts[0] || '0000';
    const m = dateParts[1] || '00';
    const d = dateParts[2] || '00';
    return path.join(this.projectDir(projectName), 'ledger', y, m, d);
  }

  // ── Soul Board (with in-memory cache) ──

  readBoard(projectName: string): SoulBoard {
    const filePath = this.boardPath(projectName);
    const cached = this._boardCache.get(projectName);

    // Check if file was modified externally (multi-agent safety)
    try {
      const stat = fs.statSync(filePath);
      const diskMtime = stat.mtimeMs;
      if (cached && cached.mtime >= diskMtime) {
        return cached.board;
      }
    } catch {
      // File doesn't exist yet — return default
    }

    const board = readJson<SoulBoard>(filePath) || this._defaultBoard(projectName);
    this._boardCache.set(projectName, { board, mtime: Date.now() });
    return board;
  }

  writeBoard(projectName: string, board: SoulBoard): void {
    board.updatedAt = nowISO();
    writeJson(this.boardPath(projectName), board);
    this._boardCache.set(projectName, { board, mtime: Date.now() });
  }

  private _defaultBoard(projectName: string): SoulBoard {
    return {
      project: projectName,
      updatedAt: nowISO(),
      updatedBy: null,
      state: { summary: '', version: '', health: 'unknown' } as BoardState,
      activeWork: {},
      fileOwnership: {},
      decisions: [],
      handoff: { from: null, summary: '', todo: [], blockers: [] } as Handoff,
      lastLedger: null,
    };
  }

  // ── File Ownership ──

  claimFile(
    projectName: string, filePath: string, agent: string, intent: string,
  ): ClaimResult {
    const board = this.readBoard(projectName);
    const existing = board.fileOwnership[filePath];
    if (existing && existing.owner && existing.owner !== agent) {
      return { ok: false, owner: existing.owner, intent: existing.intent };
    }
    board.fileOwnership[filePath] = { owner: agent, since: nowISO(), intent } as FileOwnership;
    board.updatedBy = agent;
    this.writeBoard(projectName, board);
    return { ok: true };
  }

  releaseFiles(projectName: string, agent: string): void {
    const board = this.readBoard(projectName);
    for (const [fp, info] of Object.entries(board.fileOwnership)) {
      if (info.owner === agent) {
        board.fileOwnership[fp] = { owner: null };
      }
    }
    board.updatedBy = agent;
    this.writeBoard(projectName, board);
  }

  // ── Active Work ──

  setActiveWork(
    projectName: string, agent: string, task: string, files?: string[],
  ): void {
    const board = this.readBoard(projectName);
    board.activeWork[agent] = {
      task, since: nowISO(), files: files || [],
    } as ActiveWork;
    board.updatedBy = agent;
    this.writeBoard(projectName, board);
  }

  clearActiveWork(projectName: string, agent: string): void {
    const board = this.readBoard(projectName);
    board.activeWork[agent] = null;
    board.updatedBy = agent;
    this.writeBoard(projectName, board);
  }

  // ── Ledger ──

  getNextLedgerId(projectName: string, date?: string): string {
    const dir = this.ledgerDir(projectName, date);
    if (!fs.existsSync(dir)) return '001';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const nums = files.map(f => parseInt(f.split('-')[0] || '0') || 0);
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return String(max + 1).padStart(3, '0');
  }

  writeLedger(
    projectName: string, agent: string, entry: LedgerInputEntry,
  ): { id: string; path: string } {
    const date = nowISO().split('T')[0] ?? '';
    const id = this.getNextLedgerId(projectName, date);
    const ledgerEntry: LedgerEntry = {
      id,
      agent,
      startedAt: entry.startedAt || nowISO(),
      completedAt: nowISO(),
      title: entry.title || 'Untitled work',
      filesCreated: entry.filesCreated || [],
      filesModified: entry.filesModified || [],
      filesDeleted: entry.filesDeleted || [],
      decisions: entry.decisions || [],
      summary: entry.summary || '',
    };

    const dir = this.ledgerDir(projectName, date);
    const fileName = `${id}-${agent.toLowerCase().replace(/[^a-z0-9]/g, '')}.json`;
    writeJson(path.join(dir, fileName), ledgerEntry);

    // Update board's lastLedger reference
    const dateParts = date.split('-');
    const y = dateParts[0] || '0000';
    const m = dateParts[1] || '00';
    const d = dateParts[2] || '00';
    const board = this.readBoard(projectName);
    board.lastLedger = `${y}/${m}/${d}/${id}-${agent}`;
    board.updatedBy = agent;
    this.writeBoard(projectName, board);

    return { id, path: path.join(dir, fileName) };
  }

  // ── All Projects (sorted by recency) ──

  listAllProjects(): ProjectInfo[] {
    const projectsDir = path.join(this.dataDir, 'projects');
    if (!fs.existsSync(projectsDir)) return [];
    try {
      return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_'))
        .filter(d => fs.existsSync(this.boardPath(d.name)))
        .map((d): ProjectInfo => {
          const board = this.readBoard(d.name);
          return { name: d.name, updatedAt: board.updatedAt || '', board };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (e) {
      logError('soul-engine:listAllProjects', e);
      return [];
    }
  }

  // ── File Index ──

  readFileIndex(projectName: string): FileIndex {
    return readJson<FileIndex>(this.fileIndexPath(projectName)) ||
      { updatedAt: nowISO(), tree: {}, directories: {} };
  }

  writeFileIndex(projectName: string, index: FileIndex): void {
    index.updatedAt = nowISO();
    writeJson(this.fileIndexPath(projectName), index);
  }

  /** Auto-scan a directory and generate file-index tree */
  scanDirectory(
    rootDir: string, options: ScanOptions = {},
  ): Record<string, FileEntry | DirectoryEntry> {
    const maxDepth = options.maxDepth || 5;
    const excludes = options.excludes || ['node_modules', '.git', 'dist', 'out', '.next'];

    function walk(
      dir: string, depth: number,
    ): Record<string, FileEntry | DirectoryEntry> {
      if (depth > maxDepth) return {};
      const result: Record<string, FileEntry | DirectoryEntry> = {};
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (excludes.includes(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const key = entry.name + '/';
            result[key] = {
              desc: '',
              children: walk(fullPath, depth + 1),
            } as DirectoryEntry;
          } else {
            const stat = fs.statSync(fullPath);
            result[entry.name] = {
              desc: '',
              created: stat.birthtime.toISOString().split('T')[0],
              modified: stat.mtime.toISOString().split('T')[0],
              status: 'active',
            } as FileEntry;
          }
        }
      } catch (e) {
        logError('scanDirectory', e);
      }
      return result;
    }

    return walk(rootDir, 0);
  }
}
