// n2-ark — Audit Logger. Immutable record of every action checked by the Safety Gate.
const fs = require('fs');
const path = require('path');

/**
 * Audit Logger for n2-ark Safety Gate.
 * Records every pass/block decision as an immutable log entry.
 * Essential for compliance, debugging, and accountability.
 */
class AuditLogger {
    /**
     * @param {object} options
     * @param {string} options.dir — Audit log directory
     * @param {boolean} options.enabled — Enable/disable logging (default: true)
     * @param {number} options.maxAgeDays — Auto-cleanup after N days (default: 30)
     * @param {boolean} options.logPasses — Log passed actions too (default: false)
     */
    constructor(options = {}) {
        this.dir = options.dir || path.join(process.cwd(), 'data', 'audit');
        this.enabled = options.enabled !== false;
        this.maxAgeDays = options.maxAgeDays || 7;
        this.logPasses = options.logPasses || false;
        this._buffer = [];
        this._flushInterval = null;

        if (this.enabled) {
            if (!fs.existsSync(this.dir)) {
                fs.mkdirSync(this.dir, { recursive: true });
            }
            // Flush buffer every 5 seconds
            this._flushInterval = setInterval(() => this._flush(), 5000);
            this._flushInterval.unref();  // Don't keep process alive just for audit flush

            // Auto-cleanup old logs on startup
            try { this.cleanup(); } catch (e) { /* silent */ }
        }
    }

    /**
     * Log a gate decision.
     *
     * @param {object} result — Gate check result
     * @param {object} action — Original action that was checked
     */
    log(result, action = {}) {
        if (!this.enabled) return;
        if (result.allowed && !this.logPasses) return;

        const entry = {
            timestamp: new Date().toISOString(),
            decision: result.allowed ? 'PASS' : 'BLOCK',
            action: result.action || action.name || 'unknown',
            type: action.type || 'tool_call',
            rule: result.rule || null,
            reason: result.reason || null,
            pattern: result.pattern || null,
            requires: result.requires || null,
            currentState: result.currentState || null,
        };

        this._buffer.push(entry);

        // Immediate flush for blocks (important events)
        if (!result.allowed) {
            this._flush();
        }
    }

    /**
     * Flush buffer to disk.
     */
    _flush() {
        if (this._buffer.length === 0) return;

        const today = new Date().toISOString().slice(0, 10);
        const logFile = path.join(this.dir, `${today}.jsonl`);

        try {
            const lines = this._buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.appendFileSync(logFile, lines);
            this._buffer = [];
        } catch (e) {
            console.error(`[n2-ark] Audit write failed: ${e.message}`);
        }
    }

    /**
     * Read audit log for a specific date.
     *
     * @param {string} date — YYYY-MM-DD format
     * @returns {object[]} Array of audit entries
     */
    read(date) {
        const logFile = path.join(this.dir, `${date}.jsonl`);
        if (!fs.existsSync(logFile)) return [];

        try {
            return fs.readFileSync(logFile, 'utf-8')
                .split('\n')
                .filter(l => l.trim())
                .map(l => JSON.parse(l));
        } catch (e) {
            return [];
        }
    }

    /**
     * Get block statistics for a date range.
     *
     * @param {number} days — Number of days to look back
     * @returns {{ totalChecks: number, blocked: number, passed: number, topBlocked: object[] }}
     */
    stats(days = 7) {
        let totalChecks = 0;
        let blocked = 0;
        const blockCounts = {};

        for (let i = 0; i < days; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const entries = this.read(d.toISOString().slice(0, 10));

            for (const entry of entries) {
                totalChecks++;
                if (entry.decision === 'BLOCK') {
                    blocked++;
                    const key = entry.rule || 'unknown';
                    blockCounts[key] = (blockCounts[key] || 0) + 1;
                }
            }
        }

        const topBlocked = Object.entries(blockCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([rule, count]) => ({ rule, count }));

        return {
            totalChecks,
            blocked,
            passed: totalChecks - blocked,
            topBlocked,
        };
    }

    /**
     * Cleanup old audit logs.
     * @returns {{ deleted: number }}
     */
    cleanup() {
        if (!fs.existsSync(this.dir)) return { deleted: 0 };

        const cutoff = Date.now() - (this.maxAgeDays * 24 * 60 * 60 * 1000);
        let deleted = 0;

        for (const file of fs.readdirSync(this.dir)) {
            if (!file.endsWith('.jsonl')) continue;
            const dateStr = file.replace('.jsonl', '');
            const fileDate = new Date(dateStr).getTime();
            if (fileDate < cutoff) {
                try {
                    fs.unlinkSync(path.join(this.dir, file));
                    deleted++;
                } catch (e) { /* skip */ }
            }
        }

        return { deleted };
    }

    /**
     * Stop the flush interval and write remaining buffer.
     */
    close() {
        if (this._flushInterval) {
            clearInterval(this._flushInterval);
            this._flushInterval = null;
        }
        this._flush();
    }
}

module.exports = { AuditLogger };
