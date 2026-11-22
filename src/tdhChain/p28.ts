import { getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';
import { TdhTokenLeaf, TdhWalletLeaf } from './tdh-chain.types';

/**
 * The 6529 chain's TDH commitments (6529chain P28, canonical encodings):
 *
 * - `TAG(name) = keccak256(ASCII name)` (3.1);
 * - `H(name, f1, ..., fk) = keccak256(abi.encode(TAG(name), f1, ..., fk))`,
 *   every field one 32-byte word except `address[]`, which abi.encode puts
 *   in the tail behind an offset word (2.7);
 * - the list tree LT: `NODE(l, r) = keccak256(TAG("6529.MerkleNode.v1") || l
 *   || r)`, adjacent entries paired left to right, an odd last entry promoted
 *   unchanged, and `ROOT(class, L) = H(class, uint64 len(L), bytes32 TOP(L))`
 *   (3.3);
 * - the cid, the wallet leaf and the token leaf (2.4, 4.3, 4.12).
 *
 * The test vectors are P28 4.11's.
 */

export const WALLET_LEAF_CLASS = '6529.TdhWalletLeaf.v1';
export const WALLET_ROOT_CLASS = '6529.TdhWalletRoot.v1';
export const TOKEN_LEAF_CLASS = '6529.TdhTokenLeaf.v1';
export const TOKEN_ROOT_CLASS = '6529.TdhTokenRoot.v1';
export const IDENTITY_CLASS = '6529.TdhIdentity.v1';
const NODE_CLASS = '6529.MerkleNode.v1';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT256_LIMIT = BigInt(1) << BigInt(256);

const tags = new Map<string, Uint8Array>();

export function tag(name: string): Uint8Array {
  let t = tags.get(name);
  if (!t) {
    t = getBytes(keccak256(toUtf8Bytes(name)));
    tags.set(name, t);
  }
  return t;
}

export function isAddress(value: string): boolean {
  return ADDRESS.test(value);
}

export function isBytes32(value: string): boolean {
  return BYTES32.test(value);
}

function wordUint(value: number | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${value} is not a safe integer`);
  }
  if (v < BigInt(0) || v >= UINT256_LIMIT) {
    throw new Error(`${value} is outside uint256`);
  }
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > BigInt(0); i--) {
    word[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return word;
}

function wordAddress(address: string): Uint8Array {
  if (!isAddress(address)) {
    throw new Error(`${address} is not a lowercase address`);
  }
  const word = new Uint8Array(32);
  word.set(getBytes(address), 12);
  return word;
}

function wordBytes32(value: string): Uint8Array {
  if (!isBytes32(value)) {
    throw new Error(`${value} is not a lowercase bytes32`);
  }
  return getBytes(value);
}

function hashWords(name: string, words: Uint8Array[]): Uint8Array {
  const buf = new Uint8Array(32 * (words.length + 1));
  buf.set(tag(name), 0);
  words.forEach((w, i) => buf.set(w, 32 * (i + 1)));
  return getBytes(keccak256(buf));
}

/** `H(name, words...)` for fields that are all one word each. */
export function taggedHash(name: string, words: Uint8Array[]): string {
  return hexlify(hashWords(name, words));
}

/** Ascending order of lowercase hex of one width: numeric order. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Strictly ascending as unsigned integers (lowercase hex of one width). */
function strictlyAscending(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i - 1] < values[i])) return false;
  }
  return true;
}

/**
 * `cid = H("6529.TdhIdentity.v1", address[] wallets)`, wallets strictly
 * ascending (P28 2.4). A singleton is hashed too.
 */
export function cidOf(wallets: readonly string[]): string {
  if (wallets.length === 0 || !strictlyAscending(wallets)) {
    throw new Error('cid wallets must be non-empty and strictly ascending');
  }
  const buf = new Uint8Array(32 * (3 + wallets.length));
  buf.set(tag(IDENTITY_CLASS), 0);
  // The head has two words, so the array starts at byte 64.
  buf.set(wordUint(64), 32);
  buf.set(wordUint(wallets.length), 64);
  wallets.forEach((w, i) => buf.set(wordAddress(w), 32 * (3 + i)));
  return keccak256(buf);
}

/**
 * 6529.io's consolidation key: the wallets, lowercase, ascending, joined
 * with `-`. The same wallets, in the same order, as the cid.
 */
export function consolidationKeyOf(wallets: readonly string[]): string {
  return wallets
    .map((w) => w.toLowerCase())
    .sort(compareText)
    .join('-');
}

export function walletsOfConsolidationKey(key: string): string[] {
  return key
    .toLowerCase()
    .split('-')
    .filter((w) => w !== '');
}

export function walletLeafHash(leaf: TdhWalletLeaf): Uint8Array {
  return hashWords(WALLET_LEAF_CLASS, [
    wordAddress(leaf.wallet),
    wordBytes32(leaf.cid),
    wordUint(leaf.identityTdh),
    wordUint(leaf.walletTdh),
    wordUint(leaf.walletCount)
  ]);
}

export function tokenLeafHash(leaf: TdhTokenLeaf): Uint8Array {
  return hashWords(TOKEN_LEAF_CLASS, [
    wordBytes32(leaf.cid),
    wordAddress(leaf.contract),
    wordUint(BigInt(leaf.tokenId)),
    wordUint(leaf.tokenTdh)
  ]);
}

/** `NODE(l, r)`. */
export function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(96);
  buf.set(tag(NODE_CLASS), 0);
  buf.set(left, 32);
  buf.set(right, 64);
  return getBytes(keccak256(buf));
}

/** `TOP(L)`: 32 zero bytes for an empty list, the leaf for one. */
export function merkleTop(hashes: readonly Uint8Array[]): Uint8Array {
  if (hashes.length === 0) return new Uint8Array(32);
  let level = hashes.slice();
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? merkleNode(level[i], level[i + 1]) : level[i]
      );
    }
    level = next;
  }
  return level[0];
}

/** `ROOT(class, L) = H(class, uint64 len(L), bytes32 TOP(L))`. */
export function listRoot(
  rootClass: string,
  hashes: readonly Uint8Array[]
): string {
  return taggedHash(rootClass, [wordUint(hashes.length), merkleTop(hashes)]);
}

export function walletRoot(leaves: readonly TdhWalletLeaf[]): string {
  return listRoot(WALLET_ROOT_CLASS, leaves.map(walletLeafHash));
}

export function tokenRoot(leaves: readonly TdhTokenLeaf[]): string {
  return listRoot(TOKEN_ROOT_CLASS, leaves.map(tokenLeafHash));
}

/**
 * P28 3.3's `verify`: whether `leaf` at `index` of a list of `n` entries
 * reaches `top` through `siblings`, bottom up. The caller takes `n` and
 * `top` from an authenticated root.
 */
export function verifyPath(
  leaf: Uint8Array,
  index: number,
  n: number,
  siblings: readonly Uint8Array[],
  top: Uint8Array
): boolean {
  if (!(index >= 0 && index < n)) return false;
  let h = leaf;
  let i = index;
  let last = n - 1;
  let k = 0;
  while (last > 0) {
    if (i % 2 === 1) {
      if (k >= siblings.length) return false;
      h = merkleNode(siblings[k], h);
      k++;
    } else if (i < last) {
      if (k >= siblings.length) return false;
      h = merkleNode(h, siblings[k]);
      k++;
    }
    i = Math.floor(i / 2);
    last = Math.floor(last / 2);
  }
  return k === siblings.length && hexlify(h) === hexlify(top);
}
