import * as fs from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { IdentityExportUsageError } from './cli-options';

type Write = (chunk: string) => Promise<void>;

async function writeArray(write: Write, values: unknown[]): Promise<void> {
  if (!values.length) {
    await write('[]');
    return;
  }
  await write('[\n');
  for (let i = 0; i < values.length; i++) {
    const comma = i < values.length - 1 ? ',' : '';
    await write(`    ${JSON.stringify(values[i])}${comma}\n`);
  }
  await write('  ]');
}

/** The document as one JSON object, one array element a line. */
async function writeDocument(
  write: Write,
  document: Record<string, unknown>
): Promise<void> {
  await write('{\n');
  const entries = Object.entries(document).filter(
    ([, value]) => value !== undefined
  );
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    await write(`  ${JSON.stringify(key)}: `);
    if (Array.isArray(value)) {
      await writeArray(write, value);
    } else {
      await write(JSON.stringify(value));
    }
    await write(i < entries.length - 1 ? ',\n' : '\n');
  }
  await write('}\n');
}

/**
 * The bytes writeJsonDocument writes, for an upload: built from buffers,
 * never from one string as long as the export.
 */
export async function jsonDocumentBytes(
  document: Record<string, unknown>
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await writeDocument(async (chunk) => {
    chunks.push(Buffer.from(chunk, 'utf8'));
  }, document);
  return Buffer.concat(chunks);
}

/**
 * Writes the export document as one JSON object, one array element at a time,
 * so a large export never becomes a single string in memory. The output
 * parses to the same value as JSON.stringify(document).
 */
export async function writeJsonDocument(
  file: string,
  document: Record<string, unknown>
): Promise<void> {
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  // Settles on the stream's end or its error (a missing or full disk), and
  // listens for that error from the start.
  const done = finished(out);
  done.catch(() => undefined);
  const write: Write = async (chunk) => {
    if (out.destroyed) await done;
    if (!out.write(chunk)) {
      await Promise.race([once(out, 'drain'), done]);
    }
  };
  try {
    await writeDocument(write, document);
    out.end();
  } catch (error) {
    out.destroy();
    throw error;
  }
  await done;
}

/**
 * Refuses an out path that exists, unless it may be replaced, and one whose
 * directory is missing or can't be written.
 */
export function checkOutPath(out: string, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(out)) {
    throw new IdentityExportUsageError(
      `${out} exists: pass --overwrite to replace it`
    );
  }
  const dir = path.dirname(path.resolve(out));
  let writable = false;
  try {
    writable =
      fs.statSync(dir).isDirectory() &&
      (fs.accessSync(dir, fs.constants.W_OK), true);
  } catch {
    writable = false;
  }
  if (!writable) {
    throw new IdentityExportUsageError(
      `${dir} is not a directory that can be written`
    );
  }
}

/**
 * Writes the export file: to `out`.tmp, renamed to `out` once complete, so
 * a run cut short never leaves a partial file under the real name. The
 * identities sync's state, checked before, isn't part of the file (stats
 * carry its numbers).
 */
export async function writeExportFile(
  out: string,
  document: Record<string, unknown>,
  overwrite: boolean
): Promise<void> {
  checkOutPath(out, overwrite);
  const file = Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== 'identity_sync')
  );
  const tmp = `${out}.tmp`;
  await writeJsonDocument(tmp, file);
  // On disk before it takes the real name.
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, out);
  // The rename itself on disk, where the platform lets a directory be
  // synced (not Windows).
  try {
    const dir = fs.openSync(path.dirname(path.resolve(out)), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // A directory can't be opened or synced here: the file itself is synced.
  }
}
