// Compile into a fresh directory; retain the previous build so stale files cannot ship.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist');
const base = path.join(root, '.release-check'); fs.mkdirSync(base, { recursive: true });
const staging = fs.mkdtempSync(path.join(base, 'build-')), output = path.join(staging, 'dist');
function withinWorkspace(target) {
  const absolute = path.resolve(target), relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Build target escapes workspace');
  return absolute;
}
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--outDir', output, '--declarationDir', output], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status || 1);
const localConfig = path.join(dist, 'lib/config.local.js');
if (fs.existsSync(localConfig)) fs.copyFileSync(localConfig, path.join(output, 'lib/config.local.js'));
const retained = path.join(staging, 'previous-dist');
withinWorkspace(dist); withinWorkspace(retained); withinWorkspace(output);
if (fs.existsSync(dist)) fs.renameSync(dist, retained);
try { fs.renameSync(output, dist); }
catch (error) { if (fs.existsSync(retained)) fs.renameSync(retained, dist); throw error; }
