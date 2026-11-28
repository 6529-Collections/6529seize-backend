import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  closeServer,
  listenLoopback,
  readProvenance,
  RunningSource
} from '@/rebuild/sources/running-source';

/** `<dir>/files.json`: each file's id and the SHA-256 of its bytes. */
export const FILE_INDEX = 'files.json';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** `/ipfs/<cid>`, `/ar/<id>`, `/docs/<cid>` or `/<id>`, optionally with a path suffix. */
const ROUTE = /^\/(?:(?:ipfs|ar|docs)\/)?([A-Za-z0-9_-]{1,128})(?:[/?].*)?$/;

export function fileIdOf(urlPath: string): string | null {
  const match = ROUTE.exec(urlPath);
  return match ? match[1] : null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A name that is a lowercase hex SHA-256: the id of the bytes it names. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * A CIDv1 in base32 (`b`, RFC 4648 lower case, no padding): its version,
 * codec and multihash.
 */
const CID_V1_BASE32 = /^b[a-z2-7]{58}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** CIDv1, the raw codec, sha2-256, 32 bytes. */
const RAW_SHA256_PREFIX = Buffer.from([0x01, 0x55, 0x12, 0x20]);

/** The bytes of unpadded base32, or null when its leftover bits aren't zero. */
function base32Bytes(text: string): Buffer | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // A canonical encoding pads the last byte with zero bits.
  if (value & ((1 << bits) - 1)) return null;
  return Buffer.from(out);
}

/**
 * The SHA-256 a file's name says its bytes have: a lowercase hex SHA-256,
 * or a raw CIDv1 with a sha2-256 multihash (`bafkrei...`). Null for any
 * other name, which says nothing checkable about the bytes.
 */
export function namedSha256(name: string): string | null {
  if (HEX_SHA256.test(name)) return name;
  if (!CID_V1_BASE32.test(name)) return null;
  const bytes = base32Bytes(name.slice(1));
  if (
    !bytes ||
    bytes.length !== 36 ||
    !bytes.subarray(0, 4).equals(RAW_SHA256_PREFIX)
  ) {
    return null;
  }
  return bytes.subarray(4).toString('hex');
}

/**
 * Checks every file against `files.json`: a file listed with another hash,
 * or listed and missing, is a problem. Files not listed are served but
 * reported, so the index stays complete.
 *
 * A file named by the SHA-256 of its bytes (in hex, or as a raw CIDv1)
 * has its id checked against its bytes, the one check a files directory
 * from outside the run can pass today. A file with such a name and other
 * bytes is a problem. Every other file is listed in `unverified`.
 */
export function checkFiles(dir: string): {
  readonly files: Map<string, Buffer>;
  readonly problems: string[];
  readonly unverified: string[];
} {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  const unverified: string[] = [];
  const indexFile = path.join(dir, FILE_INDEX);
  const index: Record<string, string> = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const full = path.join(dir, name);
    if (!ID.test(name) || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    files.set(name, bytes);
    const hash = sha256(bytes);
    const named = namedSha256(name);
    if (named === null) unverified.push(name);
    else if (hash !== named) {
      problems.push(
        `${name} is named by a SHA-256, but its bytes hash to ${hash}`
      );
    }
    if (!(name in index)) problems.push(`${name} is not in ${FILE_INDEX}`);
    else if (index[name] !== sha256(bytes)) {
      problems.push(`${name} does not match its hash in ${FILE_INDEX}`);
    }
  }
  for (const name of Object.keys(index)) {
    if (!files.has(name))
      problems.push(`${name} is in ${FILE_INDEX} but missing`);
  }
  return {
    files,
    problems,
    unverified: unverified.sort((a, b) => (a < b ? -1 : Number(a > b)))
  };
}

/**
 * A file the run's seeds wrote into `seedDir` and listed in its own
 * files.json, read and checked against its hash when it is asked for.
 */
function seedFile(
  seedDir: string,
  id: string,
  problems: string[]
): Buffer | undefined {
  const note = (problem: string) => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  const indexFile = path.join(seedDir, FILE_INDEX);
  if (!fs.existsSync(indexFile)) return undefined;
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    note(`the seeds' ${FILE_INDEX} is not valid JSON`);
    return undefined;
  }
  const file = path.join(seedDir, id);
  if (
    !Object.prototype.hasOwnProperty.call(index, id) ||
    !fs.existsSync(file)
  ) {
    return undefined;
  }
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== index[id]) {
    note(`seed file ${id} does not match its hash in ${FILE_INDEX}`);
    return undefined;
  }
  return bytes;
}

/**
 * Serves a directory of content-addressed files on loopback, and, when
 * given, the files the run's seeds write into `seedDir`.
 *
 * Files the seeds write are the run's own world. A file in `dir` comes
 * from outside the run. One named by the SHA-256 of its bytes (in hex, or
 * as a raw CIDv1) is checked. For any other, nothing checks its id against
 * its bytes yet (an IPFS CID of another codec recomputed, an Arweave id
 * against its transaction), so a directory that holds one is provisional,
 * whatever its PROVENANCE.json says: a label is never a basis. The reason
 * names those files.
 */
export async function startFileServer(
  dir: string,
  seedDir?: string
): Promise<RunningSource> {
  const { files, problems, unverified } = checkFiles(dir);
  const missing: string[] = [];
  const provenance = readProvenance(dir);
  const server = http.createServer((request, response) => {
    const id = fileIdOf(request.url ?? '');
    const bytes = id
      ? (files.get(id) ??
        (seedDir ? seedFile(seedDir, id, problems) : undefined))
      : undefined;
    if (!bytes) {
      missing.push(request.url ?? '');
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(bytes);
  });
  const { url } = await listenLoopback(server);
  return {
    name: 'files',
    url,
    info: {
      url,
      mode: 'local',
      provenance: provenance?.made_by ?? `${files.size} files in ${dir}`,
      provisional: unverified.length > 0,
      ...(unverified.length > 0
        ? {
            provisionalWhy: `ids not verified: ${unverified.slice(0, 5).join(', ')}${unverified.length > 5 ? ` and ${unverified.length - 5} more` : ''}`
          }
        : {})
    },
    problems: () => [
      ...problems.map((p) => `files: ${p}`),
      ...(missing.length
        ? [
            `files: ${missing.length} requests for files not in the directory, first ${missing.slice(0, 5).join(', ')}`
          ]
        : [])
    ],
    stop: () => closeServer(server)
  };
}
