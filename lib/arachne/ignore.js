// ignore.js — File exclusion rules (.gitignore + .contextignore)
const fs = require('fs');
const path = require('path');

class IgnoreFilter {
    /**
     * @param {object} config - Ignore config (config.ignore)
     * @param {string} projectDir - Project root path
     */
    constructor(config, projectDir) {
        this._patterns = [];
        this._projectDir = projectDir;

        // 1. Default patterns (from config.default.js)
        if (config.patterns && config.patterns.length > 0) {
            this._patterns.push(...config.patterns);
        }

        // 2. Load .gitignore
        if (config.useGitignore) {
            this._loadIgnoreFile(path.join(projectDir, '.gitignore'));
        }

        // 3. Load .contextignore (highest priority)
        if (config.useContextignore) {
            this._loadIgnoreFile(path.join(projectDir, '.contextignore'));
        }

        // Pre-compile patterns to regex
        this._compiled = this._patterns.map(p => this._globToRegex(p));
    }

    /**
     * Check if file path should be excluded
     * @param {string} relativePath - Relative path from project root
     * @returns {boolean} true if excluded
     */
    isIgnored(relativePath) {
        // Normalize path (Windows backslash → slash)
        const normalized = relativePath.replace(/\\/g, '/');

        for (const regex of this._compiled) {
            if (regex.test(normalized)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Filter excluded paths from file list
     * @param {string[]} paths - Array of relative paths
     * @returns {string[]} Only included paths
     */
    filter(paths) {
        return paths.filter(p => !this.isIgnored(p));
    }

    /** @returns {number} Number of loaded patterns */
    get patternCount() {
        return this._compiled.length;
    }

    /**
     * Load ignore file (.gitignore / .contextignore)
     */
    _loadIgnoreFile(filePath) {
        if (!fs.existsSync(filePath)) return;

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const rawLine of lines) {
            const line = rawLine.trim();
            // Skip empty lines and comments
            if (!line || line.startsWith('#')) continue;
            // Negation patterns (!) — not yet supported, skip
            if (line.startsWith('!')) continue;
            this._patterns.push(line);
        }
    }

    /**
     * Convert glob pattern to regex
     * Supports: *, **, ?, path separators
     */
    _globToRegex(pattern) {
        // Clean leading/trailing slashes
        let p = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

        // Directory pattern (ends with /) — include all children
        if (p.endsWith('/')) {
            p += '**';
        }

        let regex = '';
        let i = 0;
        while (i < p.length) {
            const c = p[i];
            if (c === '*') {
                if (p[i + 1] === '*') {
                    if (p[i + 2] === '/') {
                        regex += '(?:.*\\/)?';
                        i += 3;
                    } else {
                        regex += '.*';
                        i += 2;
                    }
                } else {
                    regex += '[^/]*';
                    i++;
                }
            } else if (c === '?') {
                regex += '[^/]';
                i++;
            } else if (c === '.') {
                regex += '\\.';
                i++;
            } else {
                regex += c;
                i++;
            }
        }

        // Extension patterns (*.js) should match anywhere in path
        if (pattern.startsWith('*.')) {
            return new RegExp(`(?:^|\\/)${regex}$`, 'i');
        }

        return new RegExp(`^${regex}$`, 'i');
    }
}

module.exports = { IgnoreFilter };
