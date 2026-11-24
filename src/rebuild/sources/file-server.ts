import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  checkDropArchiveIndex,
  keccakHex,
  wavesFileDropArchiveRoot
} from '@/rebuild/sources/drop-archives';
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

/** The name of a file the chain names by its Keccak-256. */
const KECCAK_NAME = /^keccak256-([0-9a-f]{64})$/;
/**
 * The drop archives' index: the Keccak-256 of each wave's archive, which
 * the chain commits to only through a Waves v1 file's dropArchiveRoot.
 */
export const DROP_ARCHIVE_INDEX = 'drop-archives';

/** What the run's other sources tell the files check. */
export interface FileCheckOptions {
  /**
   * The Waves v1 file hashes the chain gives, from the gateway's recorded
   * import answers (see importAnswerFileHashes); none when there's no
   * recording to read them from.
   */
  readonly wavesFileHashes?: readonly string[];
  /**
   * Whether the gateway source those answers come from is verified: until
   * it is, the names it gives vouch for nothing yet.
   */
  readonly gatewayVerified?: boolean;
}

/**
 * The Keccak-256 a file's name says its bytes have (`keccak256-<64 hex>`),
 * null for any other name, or 'bad' for a name of another form that
 * starts keccak256- in any case (an extension, capitals).
 */
export function namedKeccak256(name: string): string | null | 'bad' {
  if (!/^keccak256-/i.test(name)) return null;
  const match = KECCAK_NAME.exec(name);
  return match ? match[1] : 'bad';
}

/**
 * Checks every file against `files.json`: a file listed with another hash,
 * or listed and missing, is a problem. Files not listed are served but
 * reported, so the index stays complete.
 *
 * A file named by the SHA-256 of its bytes (in hex, or as a raw CIDv1)
 * has its id checked against its bytes. A file named `keccak256-<hex>` has
 * its Keccak-256 checked the same way; it counts as verified when its name
 * is a Waves v1 fileHash the chain gives (`options.wavesFileHashes`), or
 * when it is an archive the drop archive index names and the index's root
 * equals that Waves v1 file's dropArchiveRoot (the index then counts as
 * verified too). A file with such a name and other bytes, or a keccak256-
 * name of another form, is a problem. Every other file, and a Keccak-named
 * file nothing on the chain vouches for, is listed in `unverified`.
 */
export function checkFiles(
  dir: string,
  options: FileCheckOptions = {}
): {
  readonly files: Map<string, Buffer>;
  readonly problems: string[];
  readonly unverified: string[];
  /** Why some files can't be checked against the chain yet, or null. */
  readonly waiting: string | null;
} {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  const unverified: string[] = [];
  const keccakFiles = new Map<string, { name: string; bytes: Buffer }>();
  const refused = new Set<string>();
  const indexFile = path.join(dir, FILE_INDEX);
  const index: Record<string, string> = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const full = path.join(dir, name);
    const keccakNamed = namedKeccak256(name);
    if (keccakNamed === 'bad') {
      // Refused, not skipped: such a name would be served nowhere.
      refused.add(name);
      problems.push(
        `${name} starts keccak256- but isn't keccak256- and 64 lowercase hex digits`
      );
      continue;
    }
    if (!ID.test(name) || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    files.set(name, bytes);
    const hash = sha256(bytes);
    const named = namedSha256(name);
    if (keccakNamed !== null) {
      const keccak = keccakHex(bytes);
      if (keccak !== keccakNamed) {
        problems.push(
          `${name} is named by a Keccak-256, but its bytes hash to ${keccak}`
        );
      } else {
        // Attested below: the Waves v1 file the chain names, or an
        // archive a checked index names.
        keccakFiles.set(keccakNamed, { name, bytes });
      }
    } else if (named === null) unverified.push(name);
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
    if (!files.has(name) && !refused.has(name)) {
      problems.push(`${name} is in ${FILE_INDEX} but missing`);
    }
  }
  const attested = attestKeccakFiles(files, keccakFiles, unverified, options);
  problems.push(...attested.problems);
  return {
    files,
    problems,
    unverified: unverified.sort((a, b) => (a < b ? -1 : Number(a > b))),
    waiting: attested.waiting
  };
}

/**
 * Which Keccak-named files the chain attests. The Waves v1 file is the one
 * named by the fileHash of the gateway's recorded import answers
 * (`wavesFileHashes`; none counts when they name more than one), and only
 * its dropArchiveRoot may vouch for the drop archive index; an archive
 * counts once the checked index names it, at the size the index lists.
 * They all count only while the gateway source is verified: a name from a
 * gateway answer that isn't verified yet vouches for nothing. Any
 * other Keccak-named file, and anything the chain can't vouch for yet,
 * stays unverified, with `waiting` saying why. Faults in the index, a
 * root that differs, an archive of another size, and a named Waves v1
 * file that isn't one are problems.
 */
function attestKeccakFiles(
  files: ReadonlyMap<string, Buffer>,
  keccakFiles: ReadonlyMap<string, { name: string; bytes: Buffer }>,
  unverified: string[],
  options: FileCheckOptions
): { problems: string[]; waiting: string | null } {
  const problems: string[] = [];
  const reasons: string[] = [];
  const named = options.wavesFileHashes ?? [];
  if (named.length > 1) {
    reasons.push(
      `the gateway's import answers name more than one Waves v1 file (${named.join(', ')}), so none counts`
    );
  }
  const wavesFiles = new Set<string>();
  const roots: string[] = [];
  for (const hash of named.length === 1 ? named : []) {
    const file = keccakFiles.get(hash);
    if (!file) continue;
    const root = wavesFileDropArchiveRoot(file.bytes);
    if (root === null) {
      problems.push(
        `${file.name} is the file the chain's import answer names, but isn't a Waves v1 file (schema 0x411D, version 1)`
      );
      continue;
    }
    wavesFiles.add(hash);
    roots.push(root);
  }
  let archives = new Map<string, number | null>();
  let indexChecked = false;
  const indexBytes = files.get(DROP_ARCHIVE_INDEX);
  if (indexBytes) {
    const checked = checkDropArchiveIndex(indexBytes, roots);
    problems.push(...checked.problems);
    if (checked.waiting && named.length <= 1) reasons.push(checked.waiting);
    archives = checked.archives;
    indexChecked = !checked.problems.length && !checked.waiting;
  }
  const vouched: string[] = [];
  let loose = 0;
  keccakFiles.forEach(({ name, bytes }, hash) => {
    if (wavesFiles.has(hash)) {
      vouched.push(name);
      return;
    }
    if (archives.has(hash)) {
      const size = archives.get(hash);
      if (size !== null && size !== undefined && size !== bytes.length) {
        problems.push(
          `${name} is ${bytes.length} bytes, but the drop archive index lists ${size}`
        );
      }
      vouched.push(name);
      return;
    }
    unverified.push(name);
    // A file the answers name already has its reason: they name more than one.
    if (named.includes(hash)) return;
    if (wavesFileDropArchiveRoot(bytes) !== null) {
      reasons.push(
        `${name} is shaped like a Waves v1 file, but no import answer names it`
      );
    } else {
      loose += 1;
    }
  });
  if (loose && !indexBytes) {
    reasons.push(
      'no drop archive index vouches for the Keccak-named files that are not the Waves v1 file'
    );
  }
  if (vouched.length || indexChecked) {
    if (options.gatewayVerified) {
      // The index's own name says nothing; the chain's root vouches for it.
      const at = unverified.indexOf(DROP_ARCHIVE_INDEX);
      if (indexChecked && at >= 0) unverified.splice(at, 1);
    } else {
      unverified.push(...vouched);
      reasons.push(
        "the Waves v1 file, the drop archive index and its archives are named by a gateway answer that isn't verified yet"
      );
    }
  }
  return { problems, waiting: reasons.length ? reasons.join('; ') : null };
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
 * as a raw CIDv1) is checked, and one named by its Keccak-256 counts once
 * the chain vouches for its name (see checkFiles). For any other, nothing
 * checks its id against its bytes yet (an IPFS CID of another codec
 * recomputed, an Arweave id against its transaction), so a directory that
 * holds one is provisional, whatever its PROVENANCE.json says: a label is
 * never a basis. The reason names those files, and what the chain hasn't
 * vouched for yet. Startup reads and hashes every file.
 */
export async function startFileServer(
  dir: string,
  seedDir?: string,
  options: FileCheckOptions = {}
): Promise<RunningSource> {
  const { files, problems, unverified, waiting } = checkFiles(dir, options);
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
            provisionalWhy: `ids not verified: ${unverified.slice(0, 5).join(', ')}${unverified.length > 5 ? ` and ${unverified.length - 5} more` : ''}${waiting ? `; ${waiting}` : ''}`
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
