import * as fs from 'node:fs';
import * as path from 'node:path';

/** One entry of a tar archive: a file with its bytes, or a directory. */
export interface TarEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly bytes: Buffer;
}

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number): number {
  const value = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) {
    throw new Error(`tar: a size field holds ${JSON.stringify(value)}`);
  }
  return value ? parseInt(value, 8) : 0;
}

/**
 * Reads a tar archive (ustar, with GNU long names) into its files and
 * directories, in order. Any other entry type (a link, a device) is
 * refused: a data directory copy holds neither.
 */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | null = null;
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 155);
    const shortName = text(header, 0, 100);
    const body = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    if (body.length !== size) throw new Error('tar: the archive is truncated');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = text(body, 0, body.length);
      continue;
    }
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = null;
    if (type === '0' || type === '\0') {
      entries.push({ name, type: 'file', bytes: Buffer.from(body) });
    } else if (type === '5') {
      entries.push({ name, type: 'directory', bytes: Buffer.alloc(0) });
    } else {
      throw new Error(
        `tar: ${name} is of type ${JSON.stringify(type)}, not a file or a directory`
      );
    }
  }
  return entries;
}

/**
 * Writes a tar's entries under `dir`. A name that is absolute or climbs
 * out of `dir` is refused before anything is written.
 */
export function extractTar(archive: Buffer, dir: string): string[] {
  const entries = readTar(archive);
  const root = path.resolve(dir);
  const targets = entries.map((entry) => {
    const target = path.resolve(root, entry.name);
    if (
      path.isAbsolute(entry.name) ||
      entry.name.split(/[\\/]/).includes('..') ||
      (target !== root && !target.startsWith(root + path.sep))
    ) {
      throw new Error(
        `tar: ${entry.name} is outside the folder it unpacks into`
      );
    }
    return target;
  });
  fs.mkdirSync(root, { recursive: true });
  entries.forEach((entry, i) => {
    if (entry.type === 'directory') {
      fs.mkdirSync(targets[i], { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targets[i]), { recursive: true });
      fs.writeFileSync(targets[i], entry.bytes);
    }
  });
  return entries.map((entry) => entry.name);
}
