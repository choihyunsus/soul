// dependency.js — Dependency graph extraction/resolution module
// Parses import/require via regex → resolves paths → stores in DB
const path = require('path');
const fs = require('fs');

// ── Language-specific dependency patterns ──

const JS_PATTERNS = [
    // ES6: import X from './path'  |  import { X } from './path'
    /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    // CommonJS: require('./path')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Dynamic: import('./path')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const PY_PATTERNS = [
    // from X.Y import Z
    /from\s+([\w.]+)\s+import/g,
    // import X.Y
    /^import\s+([\w.]+)/gm,
];

const RUST_PATTERNS = [
    // use crate::module
    /use\s+(crate::[\w:]+)/g,
    // mod module_name
    /mod\s+(\w+)\s*;/g,
];

const GO_PATTERNS = [
    // import "path"  |  import ( "path" )
    /import\s+(?:\(\s*)?["']([^"']+)["']/g,
];

/**
 * Extract dependencies from file content
 * @param {string} content - File content
 * @param {string} language - File language (js, ts, py, rs, go)
 * @returns {Array<{importPath: string, depType: string}>}
 */
function extractDependencies(content, language) {
    const patterns = _getPatternsForLanguage(language);
    if (!patterns) return [];

    const deps = [];
    const seen = new Set();

    for (const pattern of patterns) {
        // RegExp is stateful, reset lastIndex
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(content)) !== null) {
            const importPath = match[1];
            if (!importPath || seen.has(importPath)) continue;
            seen.add(importPath);

            const depType = _classifyDepType(importPath, language);
            deps.push({ importPath, depType });
        }
    }

    return deps;
}

/**
 * Resolve import path to actual file path
 * @param {string} fromFile - Relative path of the importing file
 * @param {string} importPath - Import path (e.g., './executor')
 * @param {Map<string, number>} indexedFiles - Map of indexed files (relativePath → fileId)
 * @returns {{resolvedPath: string, fileId: number}|null}
 */
function resolveImport(fromFile, importPath, indexedFiles) {
    // External package (not a relative path) → skip
    if (!_isRelativePath(importPath)) return null;

    const fromDir = path.dirname(fromFile);
    const basePath = path.join(fromDir, importPath).replace(/\\/g, '/');

    // 1. Check exact file match
    if (indexedFiles.has(basePath)) {
        return { resolvedPath: basePath, fileId: indexedFiles.get(basePath) };
    }

    // 2. Try adding extensions
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
    for (const ext of extensions) {
        const withExt = basePath + ext;
        if (indexedFiles.has(withExt)) {
            return { resolvedPath: withExt, fileId: indexedFiles.get(withExt) };
        }
    }

    // 3. Try directory index files
    const indexFiles = ['index.js', 'index.ts', 'index.jsx', 'index.tsx', 'index.mjs'];
    for (const idx of indexFiles) {
        const indexPath = basePath + '/' + idx;
        if (indexedFiles.has(indexPath)) {
            return { resolvedPath: indexPath, fileId: indexedFiles.get(indexPath) };
        }
    }

    // 4. Resolution failed
    return null;
}

/**
 * Used by indexer: extract dependencies during file indexing → save to DB
 * @param {import('./store').Store} store
 * @param {number} fileId
 * @param {string} content - File content
 * @param {string} language
 * @param {string} relativePath - File relative path
 */
function indexFileDependencies(store, fileId, content, language, relativePath) {
    // Only process languages with dependency support
    if (!_getPatternsForLanguage(language)) return;

    // Clear existing dependencies
    store.clearDependencies(fileId);

    // Extract dependencies
    const deps = extractDependencies(content, language);
    if (deps.length === 0) return;

    // Build indexed file map (path → fileId)
    const allFiles = store.getAllFiles();
    const fileMap = new Map();
    for (const f of allFiles) {
        fileMap.set(f.path, f.id);
    }

    // Resolve paths → save to DB
    const resolved = [];
    for (const dep of deps) {
        const result = resolveImport(relativePath, dep.importPath, fileMap);
        resolved.push({
            targetPath: dep.importPath,
            targetFileId: result ? result.fileId : null,
            depType: dep.depType,
        });
    }

    if (resolved.length > 0) {
        store.insertDependencies(fileId, resolved);
    }
}

// ── Utilities ──

function _getPatternsForLanguage(language) {
    switch (language) {
        case 'js': case 'jsx': case 'mjs': case 'cjs':
        case 'ts': case 'tsx':
            return JS_PATTERNS;
        case 'py':
            return PY_PATTERNS;
        case 'rs':
            return RUST_PATTERNS;
        case 'go':
            return GO_PATTERNS;
        default:
            return null;
    }
}

function _isRelativePath(importPath) {
    return importPath.startsWith('./') || importPath.startsWith('../');
}

function _classifyDepType(importPath, language) {
    if (language === 'py') return 'import';
    if (language === 'rs') return importPath.startsWith('crate::') ? 'use' : 'mod';
    if (language === 'go') return 'import';

    // JS/TS — external package vs relative path
    if (_isRelativePath(importPath)) return 'import';
    return 'external'; // node_modules
}

module.exports = {
    extractDependencies,
    resolveImport,
    indexFileDependencies,
};
