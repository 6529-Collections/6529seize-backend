// The encrypted-message seed's fixed clock and randomness. A recording of
// the relays is replayed only when the seed publishes the same events byte
// for byte, so while the seed runs, its process reads time from a clock
// that moves only when the seed moves it, and its randomness from a
// generator seeded by a fixed label. This is test code for the rebuild
// check's seed: it patches the seed's own child process and nothing else.
// The module object itself (not an import-star copy), so patches reach
// every caller.
import nodeCrypto = require('node:crypto');

/** Where the seed's clock starts: 2026-11-23 00:00 UTC. */
export const E2EE_CHECK_T0 = Date.UTC(2026, 10, 23);

export interface DeterministicSeed {
  /** The seed's current time in milliseconds. */
  now(): number;
  /** Moves the clock on. */
  advance(ms: number): void;
  /** Puts the real clock and randomness back. */
  restore(): void;
}

/** An endless byte stream: sha256(label | block number) per 32 bytes. */
class ByteStream {
  private block = 0;
  private buffer = Buffer.alloc(0);

  constructor(private readonly label: string) {}

  take(size: number): Buffer {
    while (this.buffer.length < size) {
      const next = nodeCrypto
        .createHash('sha256')
        .update(`${this.label}|${this.block++}`)
        .digest();
      this.buffer = Buffer.concat([this.buffer, next]);
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return Buffer.from(out);
  }

  /** Uniform in [0, 1), from 48 bits. */
  fraction(): number {
    return this.take(6).readUIntBE(0, 6) / 2 ** 48;
  }
}

const X25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex'
);

/**
 * Replaces `object[name]` and returns how to put it back. Some of node's
 * crypto exports are getters, so the property is redefined rather than set.
 */
function patch(object: object, name: string, value: unknown): () => void {
  const before = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: before?.enumerable ?? true
  });
  return () => {
    if (before) Object.defineProperty(object, name, before);
    else delete (object as Record<string, unknown>)[name];
  };
}

/**
 * Installs the fixed clock (Date.now, starting at `start`) and the seeded
 * generator behind crypto.randomBytes, randomUUID, randomInt,
 * randomFillSync, webcrypto.getRandomValues, generateKeyPairSync('x25519')
 * and Math.random. TypeScript here compiles to CommonJS, so every caller
 * reads these through the module object and gets the patched ones. (The
 * module's own getRandomValues cannot be redefined; nothing the seed runs
 * calls it, and a seed that drew from it would show as two recordings
 * that differ.)
 */
export function installDeterministicSeed(
  label: string,
  start: number = E2EE_CHECK_T0
): DeterministicSeed {
  const stream = new ByteStream(label);
  let time = start;
  const originalKeyPair = nodeCrypto.generateKeyPairSync;
  const randomBytes = (size: number, callback?: unknown) => {
    const bytes = stream.take(size);
    if (typeof callback === 'function') {
      process.nextTick(() =>
        (callback as (error: null, bytes: Buffer) => void)(null, bytes)
      );
      return undefined;
    }
    return bytes;
  };
  const randomUUID = () => {
    const bytes = stream.take(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const randomInt = (...args: unknown[]) => {
    const callback =
      typeof args[args.length - 1] === 'function'
        ? (args.pop() as (error: null, value: number) => void)
        : null;
    const [min, max] =
      args.length >= 2
        ? [Number(args[0]), Number(args[1])]
        : [0, Number(args[0])];
    const value = min + Math.floor(stream.fraction() * (max - min));
    if (callback) {
      process.nextTick(() => callback(null, value));
      return undefined;
    }
    return value;
  };
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const view = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength
      );
      view.set(stream.take(view.length));
    }
    return array;
  };
  const randomFillSync = <T extends ArrayBufferView>(
    buffer: T,
    offset = 0,
    size?: number
  ): T => {
    const view = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    const length = size ?? view.length - offset;
    view.set(stream.take(length), offset);
    return buffer;
  };
  const generateKeyPairSync = (type: string, options?: unknown) => {
    if (type !== 'x25519') {
      return (originalKeyPair as (...a: unknown[]) => unknown)(type, options);
    }
    if (options !== undefined) {
      // Only the key objects the HPKE seal takes are made here.
      throw new Error("The seed's x25519 keys come without export options");
    }
    const privateKey = nodeCrypto.createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, stream.take(32)]),
      format: 'der',
      type: 'pkcs8'
    });
    return {
      publicKey: nodeCrypto.createPublicKey(privateKey),
      privateKey
    };
  };
  const restores = [
    patch(Date, 'now', () => time),
    patch(Math, 'random', () => stream.fraction()),
    patch(nodeCrypto, 'randomBytes', randomBytes),
    patch(nodeCrypto, 'randomUUID', randomUUID),
    patch(nodeCrypto, 'randomInt', randomInt),
    patch(nodeCrypto, 'randomFillSync', randomFillSync),
    patch(nodeCrypto, 'generateKeyPairSync', generateKeyPairSync),
    patch(nodeCrypto.webcrypto, 'getRandomValues', getRandomValues)
  ];

  return {
    now: () => time,
    advance: (ms: number) => {
      if (!(ms >= 0)) throw new Error('The seed clock only moves forward');
      time += ms;
    },
    restore: () => {
      for (const restore of restores.reverse()) restore();
    }
  };
}
