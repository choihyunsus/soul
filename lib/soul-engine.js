// Soul MCP v6.0 — Soul engine: Board, Ledger, and File Index management.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, nowISO, logError } = require('./utils');

class SoulEngine {
    constructor(dataDir) {
        this.dataDir = dataDir;
    }

    // -- Path helpers --

    projectDir(projectName) {
        return path.join(this.dataDir, 'projects', projectName);
    }

    boardPath(projectName) {
        return path.join(this.projectDir(projectName), 'soul-board.json');
    }

    fileIndexPath(projectName) {
        return path.join(this.projectDir(projectName), 'file-index.json');
    }

    ledgerDir(projectName, date) {
        const [y, m, d] = (date || nowISO().split('T')[0]).split('-');
        return path.join(this.projectDir(projectName), 'ledger', y, m, d);
    }

    // -- Soul Board --

    readBoard(projectName) {
        return readJson(this.boardPath(projectName)) || this._defaultBoard(projectName);
    }

    writeBoard(projectName, board) {
        board.updatedAt = nowISO();
        writeJson(this.boardPath(projectName), board);
    }

    _defaultBoard(projectName) {
        return {
            project: projectName,
            updatedAt: nowISO(),
            updatedBy: null,
            state: { summary: '', version: '', health: 'unknown' },
            activeWork: {},
            fileOwnership: {},
            decisions: [],
            handoff: { from: null, summary: '', todo: [], blockers: [] },
            lastLedger: null,
        };
    }

    // -- File Ownership --

    claimFile(projectName, filePath, agent, intent) {
        const board = this.readBoard(projectName);
        const existing = board.fileOwnership[filePath];
        if (existing && existing.owner && existing.owner !== agent) {
            return { ok: false, owner: existing.owner, intent: existing.intent };
        }
        board.fileOwnership[filePath] = { owner: agent, since: nowISO(), intent };
        board.updatedBy = agent;
        this.writeBoard(projectName, board);
        return { ok: true };
    }

    releaseFiles(projectName, agent) {
        const board = this.readBoard(projectName);
        for (const [fp, info] of Object.entries(board.fileOwnership)) {
            if (info.owner === agent) {
                board.fileOwnership[fp] = { owner: null };
            }
        }
        board.updatedBy = agent;
        this.writeBoard(projectName, board);
    }

    // -- Active Work --

    setActiveWork(projectName, agent, task, files) {
        const board = this.readBoard(projectName);
        board.activeWork[agent] = { task, since: nowISO(), files: files || [] };
        board.updatedBy = agent;
        this.writeBoard(projectName, board);
    }

    clearActiveWork(projectName, agent) {
        const board = this.readBoard(projectName);
        board.activeWork[agent] = null;
        board.updatedBy = agent;
        this.writeBoard(projectName, board);
    }

    // -- Ledger --

    getNextLedgerId(projectName, date) {
        const dir = this.ledgerDir(projectName, date);
        if (!fs.existsSync(dir)) return '001';
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const nums = files.map(f => parseInt(f.split('-')[0]) || 0);
        const max = nums.length > 0 ? Math.max(...nums) : 0;
        return String(max + 1).padStart(3, '0');
    }

    writeLedger(projectName, agent, entry) {
        const date = nowISO().split('T')[0];
        const id = this.getNextLedgerId(projectName, date);
        const ledgerEntry = {
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
        const [y, m, d] = date.split('-');
        const board = this.readBoard(projectName);
        board.lastLedger = `${y}/${m}/${d}/${id}-${agent}`;
        board.updatedBy = agent;
        this.writeBoard(projectName, board);

        return { id, path: path.join(dir, fileName) };
    }

    // -- File Index --

    readFileIndex(projectName) {
        return readJson(this.fileIndexPath(projectName)) || { updatedAt: nowISO(), tree: {}, directories: {} };
    }

    writeFileIndex(projectName, index) {
        index.updatedAt = nowISO();
        writeJson(this.fileIndexPath(projectName), index);
    }

    // Auto-scan a directory and generate file-index tree
    scanDirectory(rootDir, options = {}) {
        const maxDepth = options.maxDepth || 5;
        const excludes = options.excludes || ['node_modules', '.git', 'dist', 'out', '.next'];

        function walk(dir, depth) {
            if (depth > maxDepth) return {};
            const result = {};
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
                        };
                    } else {
                        const stat = fs.statSync(fullPath);
                        result[entry.name] = {
                            desc: '',
                            created: stat.birthtime.toISOString().split('T')[0],
                            modified: stat.mtime.toISOString().split('T')[0],
                            status: 'active',
                        };
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

module.exports = { SoulEngine };
