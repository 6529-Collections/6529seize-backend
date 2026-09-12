import { createHash } from 'node:crypto';

export interface TarEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

function octal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid archive size');
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length >= length)
    throw new Error('Archive size exceeds USTAR field');
  header.write(text + '\0', offset, length, 'ascii');
}

export function tarHeader(
  path: string,
  size: number,
  type: '0' | 'x' = '0'
): Buffer {
  // Generated ASCII paths are independent of user filenames and cannot escape the bag.
  if (
    !/^[a-zA-Z0-9_=./-]+$/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '..' || part === '.') ||
    Buffer.byteLength(path) > 255
  )
    throw new Error('Invalid archive path');
  const header = Buffer.alloc(512);
  const split = path.length > 100 ? path.lastIndexOf('/') : -1;
  const name = split >= 0 ? path.slice(split + 1) : path;
  const prefix = split >= 0 ? path.slice(0, split) : '';
  if (name.length > 100 || prefix.length > 155)
    throw new Error('Archive path exceeds USTAR fields');
  header.write(name, 0, 100, 'ascii');
  header.write(prefix, 345, 155, 'ascii');
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

/** Every original is verified again while packaging; a mismatch aborts completion. */
export async function* verifiedTar(
  entries: AsyncIterable<TarEntry> | Iterable<TarEntry>
): AsyncGenerator<Buffer> {
  const paths = new Set<string>();
  for await (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('Invalid archive entry');
    const emptyHeader = tarHeader(entry.path, 0);
    if (paths.has(entry.path)) throw new Error('Duplicate archive path');
    paths.add(entry.path);
    if (entry.size_bytes >= 8 * 1024 ** 3) {
      const field = `size=${entry.size_bytes}\n`;
      let length = field.length + 2;
      while (String(length).length + 1 + field.length !== length)
        length = String(length).length + 1 + field.length;
      const pax = Buffer.from(`${length} ${field}`, 'ascii');
      yield tarHeader(`PaxHeaders/${paths.size}`, pax.length, 'x');
      yield pax;
      yield Buffer.alloc((512 - (pax.length % 512)) % 512);
      yield emptyHeader;
    } else yield tarHeader(entry.path, entry.size_bytes);
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of entry.source) {
      size += chunk.length;
      if (size > entry.size_bytes)
        throw new Error('Archive original size mismatch');
      hash.update(chunk);
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (size !== entry.size_bytes || hash.digest('hex') !== entry.sha256)
      throw new Error('Archive original fixity mismatch');
    const padding = (512 - (size % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}
