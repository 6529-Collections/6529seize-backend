import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  checkDropArchiveIndex,
  dropArchiveRoot,
  keccakHex,
  wavesFileDocsRoot,
  wavesFileDropArchiveRoot
} from '@/rebuild/sources/drop-archives';
import {
  checkDocsIndex,
  docsRoot,
  WaveDocEntry
} from '@/rebuild/sources/wave-docs';
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
/**
 * The import reader's id for the Waves v1 file: the chain names it by the
 * Keccak-256 its import answer gives.
 */
export const WAVES_FILE = 'waves-v1';
/** The import reader's id for one wave's drop archive: its waveId. */
const DROP_ARCHIVE_FILE = /^drop-archive-([0-9a-f]{64})$/;
/**
 * The documents' index (the snapshot tool's docs/index.json), which the
 * chain commits to through a Waves v1 file's docsRoot.
 */
export const DOCS_INDEX = 'docs-index';
/** The roots of an empty list: a Waves v1 file with no archives, no documents. */
const EMPTY_ARCHIVES = dropArchiveRoot([]);
const EMPTY_DOCS = docsRoot([]);

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

/** What checkFiles found. */
export interface FilesCheck {
  readonly files: Map<string, Buffer>;
  /** Faults that fail the run. */
  readonly problems: string[];
  /** Files nothing verifies: their names say nothing the run can check. */
  readonly unverified: string[];
  /**
   * Files the chain names that the directory lacks (an archive or a
   * document its checked index lists): the directory isn't the whole set.
   */
  readonly lacking: string[];
  /** Why some files can't be checked against the chain yet, or null. */
  readonly waiting: string | null;
}

/**
 * Checks every file against `files.json`: a file listed with another hash,
 * or listed and missing, is a problem. Files not listed are served but
 * reported, so the index stays complete.
 *
 * A file named by the SHA-256 of its bytes (in hex, or as a raw CIDv1) has
 * its id checked against its bytes. The files of the waves import count
 * as verified once the chain vouches for them (see attestChainFiles),
 * under the import reader's ids (`waves-v1`, `drop-archives`,
 * `drop-archive-<waveId>`, `docs-index`) or named by their Keccak-256
 * (`keccak256-<hex>`, checked against the bytes; other bytes, or a
 * keccak256- name of another form, are a problem). Every other file, and
 * a file the chain doesn't vouch for, is listed in `unverified`.
 */
export function checkFiles(
  dir: string,
  options: FileCheckOptions = {}
): FilesCheck {
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  const pending: string[] = [];
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
        // Attested below, or listed as unverified.
        keccakFiles.set(keccakNamed, { name, bytes });
        pending.push(name);
      }
    } else if (named === null) pending.push(name);
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
  const attested = attestChainFiles(
    files,
    keccakFiles,
    new Set(pending),
    options
  );
  problems.push(...attested.problems);
  return {
    files,
    problems,
    unverified: pending
      .filter((name) => !attested.vouched.has(name))
      .sort((a, b) => (a < b ? -1 : Number(a > b))),
    lacking: attested.lacking,
    waiting: attested.reasons.length ? attested.reasons.join('; ') : null
  };
}

/** A name for a file in messages: its id. */
const listed = (names: readonly string[], most = 5) =>
  `${names.slice(0, most).join(', ')}${names.length > most ? ` and ${names.length - most} more` : ''}`;

/**
 * Which of the import's files the chain vouches for, from the Waves v1
 * file down:
 * - the Waves v1 file is the one whose Keccak-256 is the fileHash of the
 *   gateway's recorded import answers (`wavesFileHashes`; none counts
 *   when they name more than one): `waves-v1`, or `keccak256-<that hash>`;
 *   it must be a Waves v1 file, and `waves-v1` with other bytes fails;
 * - the drop archive index counts when its root equals that file's
 *   dropArchiveRoot (see checkDropArchiveIndex), and then each archive it
 *   lists: `drop-archive-<waveId>` whose Keccak-256 is the entry's hash
 *   (other bytes fail), or `keccak256-<hash>`, at the size it lists; an
 *   entry with no file is `lacking`;
 * - the docs index counts when its root equals that file's docsRoot (see
 *   checkDocsIndex), and then each document it lists: the file its
 *   rawCid names, whose Keccak-256 must be the entry's hash (other bytes
 *   fail); an entry with no file is `lacking`;
 * - an index the Waves v1 file's root says isn't empty, missing from the
 *   directory, is `lacking` too: the directory isn't the whole set.
 * They all count only while the gateway source is verified: a name from a
 * gateway answer that isn't verified yet vouches for nothing. Anything
 * else of `pending` stays unverified, with `reasons` saying why when it
 * can.
 */
function attestChainFiles(
  files: ReadonlyMap<string, Buffer>,
  keccakFiles: ReadonlyMap<string, { name: string; bytes: Buffer }>,
  pending: ReadonlySet<string>,
  options: FileCheckOptions
): {
  problems: string[];
  reasons: string[];
  vouched: Set<string>;
  lacking: string[];
} {
  const problems: string[] = [];
  const reasons: string[] = [];
  const vouched = new Set<string>();
  const lacking: string[] = [];
  const named = options.wavesFileHashes ?? [];
  if (named.length > 1) {
    reasons.push(
      `the gateway's import answers name more than one Waves v1 file (${named.join(', ')}), so none counts`
    );
  }
  // The Waves v1 file, under either name.
  const wavesBytes: { name: string; bytes: Buffer }[] = [];
  const readerWaves = files.get(WAVES_FILE);
  for (const hash of named.length === 1 ? named : []) {
    const byHash = keccakFiles.get(hash);
    if (byHash) wavesBytes.push(byHash);
    if (readerWaves) {
      const keccak = keccakHex(readerWaves);
      if (keccak === hash)
        wavesBytes.push({ name: WAVES_FILE, bytes: readerWaves });
      else {
        problems.push(
          `${WAVES_FILE} hashes to ${keccak}, but the chain's import answer names ${hash}`
        );
      }
    }
  }
  if (readerWaves && !named.length) {
    reasons.push(
      `no import answer names a Waves v1 file, so ${WAVES_FILE} can't be checked against the chain`
    );
  }
  const archiveRoots: string[] = [];
  const docsRoots: string[] = [];
  for (const { name, bytes } of wavesBytes) {
    const archiveRoot = wavesFileDropArchiveRoot(bytes);
    if (archiveRoot === null) {
      problems.push(
        `${name} is the file the chain's import answer names, but isn't a Waves v1 file (schema 0x411D, version 1)`
      );
      continue;
    }
    vouched.add(name);
    archiveRoots.push(archiveRoot);
    docsRoots.push(wavesFileDocsRoot(bytes)!);
  }
  if (archiveRoots.some((root) => root !== EMPTY_ARCHIVES)) {
    if (!files.has(DROP_ARCHIVE_INDEX)) lacking.push(DROP_ARCHIVE_INDEX);
  }
  if (docsRoots.some((root) => root !== EMPTY_DOCS)) {
    if (!files.has(DOCS_INDEX)) lacking.push(DOCS_INDEX);
  }
  // The drop archive index, and the archives it lists.
  let archives = new Map<string, number | null>();
  let byWave = new Map<string, string>();
  const indexBytes = files.get(DROP_ARCHIVE_INDEX);
  if (indexBytes) {
    const checked = checkDropArchiveIndex(indexBytes, archiveRoots);
    problems.push(...checked.problems);
    if (checked.waiting && named.length <= 1) reasons.push(checked.waiting);
    archives = checked.archives;
    byWave = checked.waves;
    if (!checked.problems.length && !checked.waiting) {
      // The index's own name says nothing; the chain's root vouches for it.
      vouched.add(DROP_ARCHIVE_INDEX);
    }
  }
  const sized = (
    name: string,
    bytes: Buffer,
    size: number | null | undefined
  ) => {
    if (size !== null && size !== undefined && size !== bytes.length) {
      problems.push(
        `${name} is ${bytes.length} bytes, but the drop archive index lists ${size}`
      );
    }
  };
  const unnamedArchives: string[] = [];
  let unvouchedArchives = 0;
  files.forEach((bytes, name) => {
    const match = DROP_ARCHIVE_FILE.exec(name);
    if (!match) return;
    if (!vouched.has(DROP_ARCHIVE_INDEX)) {
      if (!indexBytes) unvouchedArchives += 1;
      return;
    }
    const listedHash = byWave.get(match[1]);
    if (listedHash === undefined) {
      unnamedArchives.push(name);
      return;
    }
    const keccak = keccakHex(bytes);
    if (keccak !== listedHash) {
      problems.push(
        `${name} hashes to ${keccak}, but the drop archive index lists ${listedHash} for its wave`
      );
      return;
    }
    sized(name, bytes, archives.get(listedHash));
    vouched.add(name);
  });
  if (unnamedArchives.length) {
    reasons.push(
      `the drop archive index lists no wave for ${listed(unnamedArchives)}`
    );
  }
  let loose = 0;
  keccakFiles.forEach(({ name, bytes }, hash) => {
    if (vouched.has(name)) return;
    if (archives.has(hash)) {
      sized(name, bytes, archives.get(hash));
      vouched.add(name);
      return;
    }
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
  if ((loose || unvouchedArchives) && !indexBytes) {
    reasons.push(
      'no drop archive index vouches for the archives (drop-archive- or Keccak-named files that are not the Waves v1 file)'
    );
  }
  if (vouched.has(DROP_ARCHIVE_INDEX)) {
    byWave.forEach((hash, waveId) => {
      if (!keccakFiles.has(hash) && !files.has(`drop-archive-${waveId}`)) {
        lacking.push(`drop-archive-${waveId}`);
      }
    });
  }
  // The docs index, and the documents it lists.
  const docsBytes = files.get(DOCS_INDEX);
  if (docsBytes) {
    const checked = checkDocsIndex(docsBytes, docsRoots);
    problems.push(...checked.problems);
    if (checked.waiting && named.length <= 1) reasons.push(checked.waiting);
    if (!checked.problems.length && !checked.waiting) {
      vouched.add(DOCS_INDEX);
      vouchDocs(files, checked.docs, vouched, lacking, problems);
    }
  }
  if (!options.gatewayVerified && (vouched.size || lacking.length)) {
    vouched.clear();
    reasons.push(
      "the Waves v1 file, the indexes and the files they list are named by a gateway answer that isn't verified yet"
    );
  }
  return {
    problems,
    reasons,
    vouched,
    // A file two entries name is lacking once.
    lacking: Array.from(new Set(lacking))
  };
}

/**
 * The documents a checked docs index lists: each is the file its rawCid
 * names (`b` and the CID in lower-case base32), already checked against
 * that name by its SHA-256, whose Keccak-256 must be the entry's hash. A
 * document with no file is lacking.
 */
function vouchDocs(
  files: ReadonlyMap<string, Buffer>,
  docs: readonly WaveDocEntry[],
  vouched: Set<string>,
  lacking: string[],
  problems: string[]
): void {
  for (const doc of docs) {
    const name = `b${base32Of(Buffer.from(doc.rawCid, 'hex'))}`;
    const bytes = files.get(name);
    if (!bytes) {
      lacking.push(name);
      continue;
    }
    const keccak = keccakHex(bytes);
    if (keccak !== doc.hash) {
      problems.push(
        `${name} hashes to ${keccak}, but the docs index lists ${doc.hash} for it`
      );
      continue;
    }
    vouched.add(name);
  }
}

/** Bytes in RFC 4648 lower-case base32, unpadded (a CID's `b` form). */
export function base32Of(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
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
  const { files, problems, unverified, lacking, waiting } = checkFiles(
    dir,
    options
  );
  // Each part says why: files nothing verifies, files the chain names the
  // directory lacks, and what the chain can't vouch for yet.
  const why = [
    ...(unverified.length ? [`ids not verified: ${listed(unverified)}`] : []),
    ...(lacking.length
      ? [`files the chain names are missing: ${listed(lacking)}`]
      : []),
    ...(waiting && (unverified.length || lacking.length) ? [waiting] : [])
  ];
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
      provisional: why.length > 0,
      ...(why.length ? { provisionalWhy: why.join('; ') } : {})
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
