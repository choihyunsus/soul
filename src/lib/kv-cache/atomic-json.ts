// Atomic snapshot publication and safe memory keys.
import { atomicWriteAsync } from '../durable';

/** Publish complete JSON only; failed writes leave the previous snapshot intact. */
export async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await atomicWriteAsync(filePath, JSON.stringify(value, null, 2));
}

/** Memory keys are names, never paths. Preserve Unicode names without sanitizing collisions. */
export function memorySegment(value: string): string {
  if (['__proto__', 'prototype', 'constructor'].includes(value) || !value || value === '.' || value === '..' || /[\\/:<>"|?*]/.test(value) || Array.from(value).some(c => c.charCodeAt(0) < 32) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(value) || value.trim() !== value) {
    throw new Error('Invalid memory path segment: ' + JSON.stringify(value));
  }
  return value;
}
