/** These files are decoded as inert UTF-8 data, never evaluated or rendered. */
export const TEXT_ASSET_EXTENSIONS = new Set([
  'txt',
  'md',
  'xmp',
  'html',
  'htm',
  'svg',
  'css',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'pde',
  'glsl',
  'vert',
  'frag',
  'sol',
  'json',
  'xml',
  'yaml',
  'yml',
  'vtt',
  'srt',
  'gltf',
  'obj',
  'mtl',
  'cos',
  'costyle',
  'cop'
]);
export const XML_ASSET_EXTENSIONS = new Set([
  'xmp',
  'svg',
  'xml',
  'cos',
  'costyle',
  'cop'
]);

function prefix(bytes: Buffer, value: string, offset = 0): boolean {
  return bytes
    .subarray(offset, offset + value.length)
    .equals(Buffer.from(value, 'binary'));
}

/** Container/header recognition only; does not assert full format or vendor conformance. */
export function specialistSignature(bytes: Buffer, extension: string): boolean {
  const text = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  switch (extension) {
    case 'icc':
    case 'icm':
      return bytes.length >= 128 && prefix(bytes, 'acsp', 36);
    case 'cosessiondb':
      return prefix(bytes, 'SQLite format 3\0');
    case 'zip':
    case 'epub':
      return prefix(bytes, 'PK\x03\x04') || prefix(bytes, 'PK\x05\x06');
    case 'html':
    case 'htm':
      return /^(?:<!doctype\s+html\b|<html\b|<!--)/i.test(text);
    case 'svg':
      return /^(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(text);
    case 'gltf':
    case 'json':
      return text.startsWith('{') || text.startsWith('[');
    case 'vtt':
      return /^WEBVTT(?:\s|$)/.test(text);
    case 'srt':
      return /^(?:\d+\s+)?\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(text);
    case 'xml':
    case 'cos':
    case 'costyle':
    case 'cop':
      return /^(?:<\?xml|<[A-Za-z_])/.test(text);
    case 'ttf':
      return prefix(bytes, '\0\x01\0\0') || prefix(bytes, 'true');
    case 'otf':
      return prefix(bytes, 'OTTO');
    case 'woff':
      return prefix(bytes, 'wOFF');
    case 'woff2':
      return prefix(bytes, 'wOF2');
    case 'glb':
      return (
        prefix(bytes, 'glTF') &&
        bytes.length >= 12 &&
        bytes.readUInt32LE(4) === 2
      );
    case 'blend':
      return prefix(bytes, 'BLENDER');
    case 'wasm':
      return prefix(bytes, '\0asm\x01\0\0\0');
    case 'webm':
      return prefix(bytes, '\x1a\x45\xdf\xa3');
    case 'ogg':
    case 'opus':
      return prefix(bytes, 'OggS');
    case 'aif':
    case 'aiff':
      return (
        prefix(bytes, 'FORM') &&
        (prefix(bytes, 'AIFF', 8) || prefix(bytes, 'AIFC', 8))
      );
    case 'exr':
      return prefix(bytes, '\x76\x2f\x31\x01');
    default:
      return TEXT_ASSET_EXTENSIONS.has(extension);
  }
}
