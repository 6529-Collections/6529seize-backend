import {
  assertWithin,
  ContainerDescription,
  FormatMetadataStripper,
  LosslessStripUnsupported,
  newRenderHash
} from './metadata-strip.types';

const IMAGE_DESCRIPTOR = 0x2c;
const EXTENSION = 0x21;
const TRAILER = 0x3b;
const GRAPHIC_CONTROL = 0xf9;
const PLAIN_TEXT = 0x01;
const APPLICATION = 0xff;
const COMMENT = 0xfe;

/** Looping control, plus the GIF colour profile extension (ICC is kept everywhere). */
const RENDER_APPLICATIONS: ReadonlySet<string> = new Set([
  'NETSCAPE2.0',
  'ANIMEXTS1.0',
  'ICCRGBG1012'
]);

interface GifBlock {
  readonly start: number;
  readonly end: number;
  /** Null when the block renders; otherwise the label of what it carries. */
  readonly dropLabel: string | null;
}

interface GifLayout {
  readonly blocks: readonly GifBlock[];
  readonly trailingBytes: number;
}

function colorTableBytes(packed: number): number {
  return packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
}

/** Skip data sub-blocks up to and including the zero-length terminator. */
function skipSubBlocks(input: Buffer, from: number): number {
  let position = from;
  for (;;) {
    assertWithin(input, position + 1, 'GIF sub-block');
    const size = input[position];
    position += 1 + size;
    if (size === 0) return position;
    assertWithin(input, position, 'GIF sub-block');
  }
}

function applicationIdentifier(input: Buffer, start: number): string {
  // 0x21 0xFF, then an 11-byte block: 8-byte identifier and 3-byte code.
  if (start + 14 > input.length || input[start + 2] !== 11) return '';
  return input.toString('latin1', start + 3, start + 14);
}

function extensionDropLabel(input: Buffer, start: number): string | null {
  const label = input[start + 1];
  if (label === GRAPHIC_CONTROL || label === PLAIN_TEXT) return null;
  if (label === COMMENT) return 'comment';
  if (label === APPLICATION) {
    const identifier = applicationIdentifier(input, start);
    return RENDER_APPLICATIONS.has(identifier)
      ? null
      : `application:${identifier.trim() || 'unknown'}`;
  }
  return `extension:${label.toString(16)}`;
}

function walkGif(input: Buffer): GifLayout {
  const signature = input.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new LosslessStripUnsupported('Not a GIF');
  }
  assertWithin(input, 13, 'GIF screen descriptor');
  const headerEnd = 13 + colorTableBytes(input[10]);
  assertWithin(input, headerEnd, 'GIF colour table');
  const blocks: GifBlock[] = [{ start: 0, end: headerEnd, dropLabel: null }];
  let position = headerEnd;
  // A file that ends cleanly between blocks without a trailer still decodes.
  while (position < input.length) {
    const introducer = input[position];
    if (introducer === TRAILER) {
      return { blocks, trailingBytes: input.length - position - 1 };
    }
    let end: number;
    let dropLabel: string | null = null;
    if (introducer === IMAGE_DESCRIPTOR) {
      assertWithin(input, position + 11, 'GIF image descriptor');
      const dataStart =
        position + 10 + colorTableBytes(input[position + 9]) + 1;
      assertWithin(input, dataStart, 'GIF local colour table');
      end = skipSubBlocks(input, dataStart);
    } else if (introducer === EXTENSION) {
      assertWithin(input, position + 2, 'GIF extension');
      end = skipSubBlocks(input, position + 2);
      dropLabel = extensionDropLabel(input, position);
    } else {
      throw new LosslessStripUnsupported('Unknown GIF block');
    }
    blocks.push({ start: position, end, dropLabel });
    position = end;
  }
  return { blocks, trailingBytes: 0 };
}

function strip(input: Buffer): Buffer {
  const { blocks } = walkGif(input);
  return Buffer.concat([
    ...blocks
      .filter((block) => block.dropLabel === null)
      .map((block) => input.subarray(block.start, block.end)),
    Buffer.from([TRAILER])
  ]);
}

function describe(input: Buffer): ContainerDescription {
  const { blocks, trailingBytes } = walkGif(input);
  const metadataBlocks: string[] = [];
  const hash = newRenderHash();
  for (const block of blocks) {
    if (block.dropLabel === null) {
      hash.update(input.subarray(block.start, block.end));
    } else {
      metadataBlocks.push(block.dropLabel);
    }
  }
  if (trailingBytes > 0) metadataBlocks.push('trailing-data');
  return {
    width: input.readUInt16LE(6),
    height: input.readUInt16LE(8),
    orientation: 1,
    renderDigest: hash.digest('hex'),
    metadataBlocks
  };
}

export const gifMetadataStripper: FormatMetadataStripper = { strip, describe };
