// Strict reads and cross-process exclusion for durable memory mutations.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const publications = new Map<string, Promise<void>>();

/** Serialize publication per file to avoid Windows rename sharing violations. */
export async function atomicWriteAsync(file: string, content: string): Promise<void> {
  const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const previous = publications.get(key) ?? Promise.resolve();
  const publication = previous.catch(() => undefined).then(async () => {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fsp.open(temp, 'wx');
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fsp.rename(temp, file);
    } finally { await fsp.rm(temp, { force: true }); }
  });
  publications.set(key, publication);
  try { await publication; }
  finally { if (publications.get(key) === publication) publications.delete(key); }
}

export function readStrict<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function atomicWrite(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

/** Fail closed on contention; reclaim only locks whose process no longer exists. */
export function acquireLock(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(file); continue; }
        }
      }
      throw new Error('Memory is busy; retry the same operation: ' + file, { cause: error });
    }
  }
  throw new Error('Could not acquire memory lock: ' + file);
}
