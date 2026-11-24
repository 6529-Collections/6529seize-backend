import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  loopbackPort,
  peerSettings,
  withLoopbackListen
} from '@/rebuild/sources/frozen-config';
import { exchangeKey, keyBody } from '@/rebuild/sources/exchange-key';
import { FrozenLock, takeFrozenLock } from '@/rebuild/sources/frozen-guard';
import type { RecordedExchange } from '@/rebuild/sources/http-recording';
import { extractTar } from '@/rebuild/sources/tar-reader';

/**
 * A gateway recording made through the frozen-snapshot API node
 * (`validator run --api-frozen-snapshot`) counts as final only when the
 * three checks pass:
 *
 * 1. Its header names, for each snapshot, the frozen height, block root,
 *    app state root and the hash of the data-dir copy it was served from,
 *    and that copy is kept.
 * 2. At least two live nodes other than the copied one reported the same
 *    block root and app state root at that height; both answers are in the
 *    header.
 * 3. The run re-serves each kept copy with the frozen option and replays
 *    the snapshot's answers to the same bytes, checking the height and the
 *    roots first.
 *
 * Every recorded line's key must be its own method, path and body, since
 * the run serves answers by key and the replay asks by path.
 *
 * A recording whose header or copies don't hold up fails the run. One the
 * run can't re-serve (no validator given) or whose build isn't named as
 * reviewed stays provisional, with the reason.
 */

export const FROZEN_OPTION = 'validator run --api-frozen-snapshot';

/** A snapshot's phase: a plain name, as reports and messages quote it. */
const PHASE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Path parts a masked field may not name. */
const UNSAFE_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

export interface LiveNodeAnswer {
  readonly node: string;
  readonly height: number;
  readonly status: number | string;
  readonly blockRoot: string;
  readonly appStateRoot: string;
}

export interface FrozenSnapshot {
  readonly phase: string;
  readonly option: string;
  readonly height: number;
  readonly blockRoot: string;
  readonly appStateRoot: string;
  readonly dataDirSha256: string;
  readonly dataDirArchive: string;
  readonly dataDirArchiveSha256: string;
  readonly copiedNode: string;
  readonly liveNodes: readonly LiveNodeAnswer[];
}

export interface FrozenHeader {
  readonly frozen?: readonly FrozenSnapshot[];
  readonly answers?: number;
  readonly answersServedFrozen?: number;
  /** The commit the frozen node was built from, in full. */
  readonly validatorCommit?: string;
  /** The binary that served the capture, on the devnet. */
  readonly validatorSha256Linux?: string;
  /** The same commit built for Windows, which re-serves the copies there. */
  readonly validatorSha256Windows?: string;
  /** The commit the Windows binary was built from, when not the capture's. */
  readonly validatorWindowsCommit?: string;
  /** The SHA-256 of `<dir>/devnet.toml`, which the copies' configs name. */
  readonly devnetSha256?: string;
  /** Answers whose snapshot tag was set after the capture. */
  readonly retagged?: readonly { readonly key?: string }[];
  /**
   * Answers that hold fields a second serving can't repeat (a process
   * counter, say): replayed and compared without those fields, and they
   * keep the recording provisional.
   */
  readonly notReplayable?: readonly NotReplayable[];
}

/** An answer the header lists as not replayable byte for byte. */
export interface NotReplayable {
  readonly key?: string;
  readonly snapshot?: string;
  /** JSON paths in its body, dot-separated (`data.requests`). */
  readonly fields?: readonly string[];
  readonly why?: string;
}

/** A recorded exchange with the snapshot that served it. */
export type FrozenExchange = RecordedExchange & { readonly snapshot?: string };

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ROOT = /^(0x)?[0-9a-fA-F]{64}$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Checks 1 and 2, on the header and the recorded lines alone: each
 * snapshot's fields, the live nodes' agreement with it, and every answer
 * tagged with one of the snapshots.
 */
export function frozenHeaderProblems(
  header: FrozenHeader,
  lines: readonly FrozenExchange[]
): string[] {
  const problems: string[] = [];
  const snapshots = header.frozen;
  if (!Array.isArray(snapshots) || !snapshots.length) {
    return ['the header names no frozen snapshot'];
  }
  // The build that served the capture, and the same build for re-serving
  // the copies here.
  if (!COMMIT.test(text(header.validatorCommit))) {
    problems.push('the header names no full validatorCommit');
  }
  if (
    header.validatorWindowsCommit !== undefined &&
    !COMMIT.test(text(header.validatorWindowsCommit))
  ) {
    problems.push("the header's validatorWindowsCommit isn't in full");
  }
  for (const field of [
    'validatorSha256Linux',
    'validatorSha256Windows'
  ] as const) {
    if (!HEX64.test(text(header[field]))) {
      problems.push(`the header names no ${field}`);
    }
  }
  if (
    header.devnetSha256 !== undefined &&
    !HEX64.test(text(header.devnetSha256))
  ) {
    problems.push("the header's devnetSha256 isn't a SHA-256");
  }
  const phases = new Set<string>();
  for (const s of snapshots) {
    if (!s || typeof s !== 'object') {
      problems.push('a snapshot in the header is not an object');
      continue;
    }
    if (typeof s.phase !== 'string' || !PHASE.test(s.phase)) {
      problems.push(
        `a snapshot's phase ${JSON.stringify(s.phase)} isn't a plain name (letters, digits, - and _, at most 64)`
      );
      continue;
    }
    const at = `snapshot ${s.phase}`;
    if (phases.has(s.phase)) problems.push(`${at} appears twice`);
    phases.add(s.phase);
    if (s.option !== FROZEN_OPTION) {
      problems.push(`${at} wasn't served by ${FROZEN_OPTION}`);
    }
    if (!Number.isInteger(s.height) || s.height <= 0) {
      problems.push(`${at} names no height`);
    }
    if (!ROOT.test(text(s.blockRoot)))
      problems.push(`${at} names no block root`);
    if (!ROOT.test(text(s.appStateRoot))) {
      problems.push(`${at} names no app state root`);
    }
    if (!HEX64.test(text(s.dataDirSha256))) {
      problems.push(`${at} names no data-dir copy hash`);
    } else if (s.dataDirArchive !== `${s.dataDirSha256}.tar.gz`) {
      problems.push(`${at}'s archive isn't named by the copy's hash`);
    }
    if (!HEX64.test(text(s.dataDirArchiveSha256))) {
      problems.push(`${at} names no archive hash`);
    }
    if (typeof s.copiedNode !== 'string' || !s.copiedNode) {
      problems.push(`${at} doesn't name the copied node`);
    }
    if (!Array.isArray(s.liveNodes)) {
      problems.push(`${at}'s liveNodes isn't a list`);
      continue;
    }
    const nodes: readonly LiveNodeAnswer[] = s.liveNodes;
    const live = nodes.filter((n) => n && typeof n === 'object');
    const others = live.filter(
      (n) => typeof n.node === 'string' && n.node && n.node !== s.copiedNode
    );
    if (new Set(others.map((n) => n.node)).size < 2) {
      problems.push(
        `${at} has fewer than two live nodes other than the copied one`
      );
    }
    for (const n of live) {
      if (n.node === s.copiedNode) {
        problems.push(`${at}'s live node ${n.node} is the copied node`);
      }
      if (n.height !== s.height) {
        problems.push(
          `${at}'s live node ${n.node} answered height ${n.height}`
        );
      }
      if (n.blockRoot !== s.blockRoot || n.appStateRoot !== s.appStateRoot) {
        problems.push(
          `${at}'s live node ${n.node} reported other roots at height ${s.height}`
        );
      }
    }
  }
  problems.push(...lineProblems(lines, phases));
  problems.push(...listProblems(header, lines));
  const listed = Array.isArray(header.notReplayable)
    ? header.notReplayable.length
    : 0;
  if (
    header.answers !== lines.length ||
    (header.answersServedFrozen ?? NaN) + listed !== lines.length
  ) {
    problems.push(
      `the header counts ${header.answers} answers, ${header.answersServedFrozen} served frozen${
        listed ? ` and ${listed} not replayable` : ''
      }, for ${lines.length} recorded`
    );
  }
  return problems;
}

/** A value as text, or '' when it isn't a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Each recorded line: its fields of the right types, tagged with one of
 * the header's snapshots, and keyed by its own method, path and body (the
 * run serves by key and the replay asks by path, so a key that names
 * another request would let one answer stand for another). No key twice.
 */
function lineProblems(
  lines: readonly FrozenExchange[],
  phases: ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  const untagged: FrozenExchange[] = [];
  const keys = new Set<string>();
  let repeated = 0;
  let firstRepeat = '';
  lines.forEach((line, i) => {
    const at = `recorded line ${i + 1}`;
    if (
      typeof line.key !== 'string' ||
      typeof line.method !== 'string' ||
      typeof line.path !== 'string' ||
      typeof line.body !== 'string' ||
      typeof line.status !== 'number'
    ) {
      problems.push(
        `${at} lacks a key, method, path, body or status of the right type`
      );
      return;
    }
    if (!line.path.startsWith('/')) {
      problems.push(
        `${at} (${line.method} ${line.path}): its path doesn't start with /`
      );
      return;
    }
    // The key sorts the query's parameters: a second ? or a repeated name
    // would let two requests share a key.
    const [, query, ...more] = line.path.split('?');
    const names = (query ?? '')
      .split('&')
      .filter(Boolean)
      .map((param) => param.split('=')[0])
      // The application reads names decoded: wh%6F is who.
      .map((name) => {
        try {
          return decodeURIComponent(name);
        } catch {
          return name;
        }
      });
    if (more.length) {
      problems.push(
        `${at} (${line.method} ${line.path}): its path has more than one ?`
      );
      return;
    }
    if (new Set(names).size !== names.length) {
      problems.push(
        `${at} (${line.method} ${line.path}): its query repeats a name`
      );
      return;
    }
    const body = keyBody(line.key);
    if (!body) {
      problems.push(
        `${at} (${line.method} ${line.path}): its key's body is neither JSON nor the empty body's hash`
      );
    } else if (exchangeKey(line.method, line.path, body) !== line.key) {
      problems.push(
        `${at}: its key isn't its own request (${line.method} ${line.path}), so its answer would serve another`
      );
    }
    if (keys.has(line.key)) {
      repeated++;
      firstRepeat ||= `${line.method} ${line.path}`;
    }
    keys.add(line.key);
    if (typeof line.snapshot !== 'string' || !phases.has(line.snapshot)) {
      untagged.push(line);
    }
  });
  if (repeated) {
    problems.push(
      `${repeated} recorded lines repeat another line's key, first ${firstRepeat}`
    );
  }
  if (untagged.length) {
    problems.push(
      `${untagged.length} answers name no snapshot of the header, first ${untagged[0].method} ${untagged[0].path}`
    );
  }
  return problems;
}

/**
 * The header's lists: each notReplayable entry names a recorded answer of
 * its snapshot, once, with at least one plain field and a reason, and no
 * answer is both retagged and listed as not replayable.
 */
function listProblems(
  header: FrozenHeader,
  lines: readonly FrozenExchange[]
): string[] {
  const problems: string[] = [];
  if (header.retagged !== undefined && !Array.isArray(header.retagged)) {
    problems.push("the header's retagged isn't a list");
  }
  if (header.notReplayable === undefined) return problems;
  if (!Array.isArray(header.notReplayable)) {
    return [...problems, "the header's notReplayable isn't a list"];
  }
  const retagged = new Set(
    (Array.isArray(header.retagged) ? header.retagged : []).map((e) => e?.key)
  );
  const seen = new Set<string>();
  for (const entry of header.notReplayable) {
    const key = typeof entry?.key === 'string' ? entry.key : '';
    const at = `notReplayable ${key || '(no key)'}`;
    if (key && seen.has(key)) problems.push(`${at} is listed twice`);
    if (key) seen.add(key);
    if (key && retagged.has(key)) {
      problems.push(`${at} is listed as retagged too`);
    }
    if (
      !lines.some(
        (line) => line.key === key && line.snapshot === entry?.snapshot
      )
    ) {
      problems.push(
        `${at} isn't a recorded answer of snapshot ${text(entry?.snapshot) || '(none)'}`
      );
    }
    const fields: readonly unknown[] | undefined = entry?.fields;
    if (
      !Array.isArray(fields) ||
      !fields.length ||
      fields.some((field) => typeof field !== 'string' || !field)
    ) {
      problems.push(`${at} names no field`);
    } else if (
      (fields as readonly string[]).some((field) =>
        field.split('.').some((part) => !part || UNSAFE_PARTS.has(part))
      )
    ) {
      problems.push(
        `${at} names a field with an empty part or __proto__, constructor or prototype`
      );
    }
    if (!text(entry?.why).trim()) problems.push(`${at} gives no reason`);
  }
  return problems;
}

/**
 * The kept copy of one snapshot, checked against both hashes and unpacked
 * into `folder`. Throws on a missing archive or a hash that doesn't match.
 */
export function unpackSnapshot(
  dir: string,
  snapshot: FrozenSnapshot,
  folder: string
): void {
  const archiveFile = path.join(dir, 'snapshots', snapshot.dataDirArchive);
  if (!fs.existsSync(archiveFile)) {
    throw new Error(
      `snapshot ${snapshot.phase}: no kept copy at snapshots/${snapshot.dataDirArchive} in the recording`
    );
  }
  const archive = fs.readFileSync(archiveFile);
  if (sha256(archive) !== snapshot.dataDirArchiveSha256) {
    throw new Error(
      `snapshot ${snapshot.phase}: the archive doesn't match its hash in the header`
    );
  }
  const tar = gunzipSync(archive);
  if (sha256(tar) !== snapshot.dataDirSha256) {
    throw new Error(
      `snapshot ${snapshot.phase}: the copy doesn't match its hash in the header`
    );
  }
  extractTar(tar, folder);
}

/** How the run starts the validator: the file it hashes and its argv. */
export interface FrozenValidator {
  /** The binary whose SHA-256 the header names. */
  readonly file: string;
  /** The command that runs it, before the validator's own arguments. */
  readonly command: readonly string[];
}

/** The header's hash field for the binary that replays on `platform`. */
export function replayHashField(
  platform: NodeJS.Platform = process.platform
): 'validatorSha256Windows' | 'validatorSha256Linux' {
  return platform === 'win32'
    ? 'validatorSha256Windows'
    : 'validatorSha256Linux';
}

/** The binary's hash and its frozen option, against the header. */
export function validatorProblems(
  validator: FrozenValidator,
  header: FrozenHeader,
  platform: NodeJS.Platform = process.platform
): string[] {
  // Both builds of one commit answer with the same bytes: the status's
  // node field is the release, not the platform.
  const field = replayHashField(platform);
  const expected = header[field];
  if (!expected) return [`the header names no ${field}`];
  if (!fs.existsSync(validator.file)) {
    return ['no file at the --validator-bin path'];
  }
  const actual = sha256(fs.readFileSync(validator.file));
  if (actual !== expected) {
    return [
      `replay binary ${actual} is not the recording's ${field} ${expected}`
    ];
  }
  const [program, ...args] = validator.command;
  const help = spawnSync(program, [...args, 'run', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  });
  if (
    !`${help.stdout ?? ''}${help.stderr ?? ''}`.includes(
      '--api-frozen-snapshot'
    )
  ) {
    return [`the validator's run --help doesn't list --api-frozen-snapshot`];
  }
  return [];
}

export interface ReplayOutcome {
  readonly replayed: number;
  readonly problems: string[];
}

/**
 * The value with the dot-separated paths deleted, walking own properties
 * only. The paths were checked to name no prototype part.
 */
function withoutPaths(value: unknown, paths: readonly string[]): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  const own = (at: unknown, part: string): at is Record<string, unknown> =>
    !!at &&
    typeof at === 'object' &&
    Object.prototype.hasOwnProperty.call(at, part);
  for (const field of paths) {
    const parts = field.split('.');
    let at: unknown = copy;
    for (const part of parts.slice(0, -1)) {
      at = own(at, part) ? at[part] : undefined;
    }
    const last = parts[parts.length - 1];
    if (own(at, last)) delete at[last];
  }
  return copy;
}

/** The first path where two JSON values differ, or null when equal. */
function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  const objects =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object';
  if (!objects || Array.isArray(a) !== Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? null : at || '(the body)';
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Array.from(
    new Set([...Object.keys(ra), ...Object.keys(rb)])
  ).sort((x, y) => (x < y ? -1 : Number(x > y)));
  for (const key of keys) {
    const path = at ? `${at}.${key}` : key;
    const inA = Object.prototype.hasOwnProperty.call(ra, key);
    const inB = Object.prototype.hasOwnProperty.call(rb, key);
    if (!inA || !inB) return path;
    const found = firstDifference(ra[key], rb[key], path);
    if (found) return found;
  }
  return null;
}

/**
 * A listed answer's body against the frozen node's, with the listed
 * fields deleted from both. Each body must be exactly what JSON.stringify
 * makes of its own parse (no spacing, no number JSON can't hold, no key
 * written twice), so nothing outside the fields is lost before the
 * compare; then the rest must match byte for byte. Returns the first
 * place they differ, or null.
 */
function maskedDifference(
  recorded: Buffer,
  served: Buffer,
  fields: readonly string[]
): string | null {
  const read = (bytes: Buffer): { value: unknown } | null => {
    const raw = bytes.toString('utf8');
    try {
      const value = JSON.parse(raw) as unknown;
      return JSON.stringify(value) === raw ? { value } : null;
    } catch {
      return null;
    }
  };
  const a = read(recorded);
  const b = read(served);
  if (!a || !b) {
    return `its ${a ? "frozen node's" : 'recorded'} body (not plain JSON, so its fields can't be left out exactly)`;
  }
  const ma = withoutPaths(a.value, fields);
  const mb = withoutPaths(b.value, fields);
  if (JSON.stringify(ma) === JSON.stringify(mb)) return null;
  return firstDifference(ma, mb) ?? 'the order of its keys';
}

/**
 * Replays one snapshot's answers against a frozen node at `url`: each
 * must come back with the recorded status, content type and bytes, or, for
 * an answer listed as not replayable, match without its listed fields.
 */
export async function replaySnapshot(
  url: string,
  exchanges: readonly FrozenExchange[],
  /** By key: the fields a listed answer is compared without. */
  masked: ReadonlyMap<string, readonly string[]> = new Map()
): Promise<ReplayOutcome> {
  const problems: string[] = [];
  let replayed = 0;
  for (const exchange of exchanges) {
    // The header check tied each key to its own method, path and body.
    const body = keyBody(exchange.key);
    if (body === null) {
      problems.push(
        `${exchange.method} ${exchange.path}: its request body isn't recorded, so it can't be replayed`
      );
      continue;
    }
    const response = await fetch(`${url}${exchange.path}`, {
      method: exchange.method,
      headers: body.length ? { 'content-type': 'application/json' } : {},
      body: body.length ? body.toString('utf8') : undefined
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const recorded =
      exchange.encoding === 'base64'
        ? Buffer.from(exchange.body, 'base64')
        : Buffer.from(exchange.body, 'utf8');
    replayed++;
    const fields = masked.get(exchange.key);
    if (
      fields &&
      response.status === exchange.status &&
      response.headers.get('content-type') === exchange.contentType
    ) {
      const differs = maskedDifference(recorded, bytes, fields);
      if (differs) {
        problems.push(
          `${exchange.method} ${exchange.path}: the frozen node's answer differs outside its notReplayable fields (${fields.join(', ')}), at ${differs}`
        );
      }
      continue;
    }
    if (
      response.status !== exchange.status ||
      response.headers.get('content-type') !== exchange.contentType ||
      !bytes.equals(recorded)
    ) {
      problems.push(
        `${exchange.method} ${exchange.path}: the frozen node answers ${response.status} with other bytes than the recording`
      );
    }
  }
  return { replayed, problems };
}

export interface FrozenNode {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Starts the validator on an unpacked copy, with the frozen option only:
 * the chain API bound to 127.0.0.1 on `port`, no peer in its config, its
 * temporary files in `tmpDir`, and one such node on the machine at a time.
 * The lock names both this process and the node's, so it stays held while
 * either lives; the node is stopped with this process (exit or SIGINT),
 * by its own handle, with SIGTERM and then SIGKILL after `killTimeoutMs`.
 */
export async function startFrozenNode(options: {
  readonly validator: FrozenValidator;
  readonly folder: string;
  readonly port: number;
  readonly tmpDir: string;
  readonly logFile: string;
  readonly lockDir?: string;
  readonly readyTimeoutMs?: number;
  readonly killTimeoutMs?: number;
  /**
   * Applied to the node's whole output before the tail an error quotes,
   * so a long path can't survive cut in half. By default the copy and
   * its temp folder become labels.
   */
  readonly redact?: (text: string) => string;
}): Promise<FrozenNode> {
  const configFile = path.join(options.folder, 'config.toml');
  if (!fs.existsSync(configFile)) {
    throw new Error('the copy has no config.toml');
  }
  const config = withLoopbackListen(
    fs.readFileSync(configFile, 'utf8'),
    options.port
  );
  const peers = peerSettings(config);
  if (peers.length) {
    throw new Error(`the copy's config names peers: ${peers.join(', ')}`);
  }
  if (loopbackPort(config) !== options.port) {
    throw new Error("the copy's chain API is not bound to 127.0.0.1");
  }
  fs.writeFileSync(configFile, config);
  const lock = takeFrozenLock(
    `a frozen node on port ${options.port}`,
    options.lockDir
  );
  if ('refused' in lock) throw new Error(lock.refused);
  let log: number | null = null;
  let child: ChildProcess | null = null;
  let closed = false;
  // This process's exit or Ctrl-C takes the node with it.
  const killNow = () => {
    if (child && !closed) child.kill('SIGKILL');
  };
  const onSigint = () => {
    killNow();
    process.exit(130);
  };
  const cleanUp = (held: FrozenLock) => {
    process.removeListener('exit', killNow);
    process.removeListener('SIGINT', onSigint);
    try {
      if (log !== null) fs.closeSync(log);
      fs.rmSync(options.tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } finally {
      held.release();
    }
  };
  try {
    fs.mkdirSync(options.tmpDir, { recursive: true });
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    log = fs.openSync(options.logFile, 'a');
    const [program, ...args] = options.validator.command;
    child = spawn(
      program,
      [...args, 'run', '--api-frozen-snapshot', '--data-dir', options.folder],
      {
        env: {
          ...process.env,
          TMPDIR: options.tmpDir,
          TEMP: options.tmpDir,
          TMP: options.tmpDir
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    process.on('exit', killNow);
    process.on('SIGINT', onSigint);
  } catch (error) {
    cleanUp(lock);
    throw error;
  }
  const node = child;
  if (node.pid) lock.holdFor(node.pid);
  let output = '';
  const fd = log;
  const note = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    fs.writeSync(fd, chunk);
  };
  node.stdout?.on('data', note);
  node.stderr?.on('data', note);
  // 'close': the process has exited and its output is all read.
  const done = new Promise<void>((resolve) => {
    node.once('close', () => {
      closed = true;
      resolve();
    });
    node.once('error', () => {
      closed = true;
      resolve();
    });
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      // Our own child, by its own handle: never a process found by name.
      if (!closed) {
        node.kill('SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(
            () => resolve('timeout'),
            options.killTimeoutMs ?? 10_000
          );
        });
        const first = await Promise.race([done, timeout]);
        // A node that closed in time leaves no timer behind.
        clearTimeout(timer);
        if (first === 'timeout') {
          node.kill('SIGKILL');
          await done;
        }
      }
    } finally {
      cleanUp(lock);
    }
  };
  const url = `http://127.0.0.1:${options.port}`;
  const serving = new RegExp(` on 127\\.0\\.0\\.1:${options.port}(?!\\d)`);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 300_000);
  try {
    for (;;) {
      if (closed) {
        const redact =
          options.redact ??
          ((text: string) =>
            redactPaths(text, {
              '<copy>': options.folder,
              '<temp>': options.tmpDir
            }));
        throw new Error(
          `the frozen node exited: ${redact(output.trim()).slice(-300)}`
        );
      }
      if (/serves .* on /.test(output)) {
        if (!serving.test(output)) {
          throw new Error('the frozen node is not serving on 127.0.0.1');
        }
        const status = await fetch(`${url}/v1/status`).catch(() => null);
        if (status?.ok) return { url, stop };
      }
      if (Date.now() > deadline) {
        throw new Error('the frozen node did not start in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The frozen node's /v1/status snapshot, against the header's. */
export async function statusProblems(
  url: string,
  snapshot: FrozenSnapshot
): Promise<string[]> {
  const response = await fetch(`${url}/v1/status`);
  // The chain API's status: { data: { snapshot: { height, root,
  // appStateRoot, ... } } }, root being the block root.
  const status = (await response.json()) as {
    data?: {
      snapshot?: { height?: number; root?: string; appStateRoot?: string };
    };
  };
  const served = status.data?.snapshot;
  if (
    !served ||
    served.height !== snapshot.height ||
    served.root !== snapshot.blockRoot ||
    served.appStateRoot !== snapshot.appStateRoot
  ) {
    return [
      `snapshot ${snapshot.phase}: the frozen node serves height ${served?.height} with other roots than the header`
    ];
  }
  return [];
}

export interface FrozenVerdict {
  /** Problems that fail the run: the recording doesn't hold up. */
  readonly problems: string[];
  /** Why the recording isn't final, when it isn't; null when it is. */
  readonly provisionalWhy: string | null;
  /** What the report should say besides, when there is anything. */
  readonly notes?: string[];
}

/**
 * Notes on a re-serve: the replay binary's hash, and on Windows a binary
 * built from another commit than the capture's (the replay is still keyed
 * on its SHA-256).
 */
export function frozenNotes(
  header: FrozenHeader,
  platform: NodeJS.Platform = process.platform,
  binarySha256?: string
): string[] {
  const windows = header.validatorWindowsCommit;
  return [
    ...(binarySha256
      ? [`the copies were re-served by the binary with SHA-256 ${binarySha256}`]
      : []),
    ...(platform === 'win32' && windows && windows !== header.validatorCommit
      ? [
          `the Windows binary that re-served the copies was built from ${windows}, the capture's from ${header.validatorCommit}; the replay is keyed on validatorSha256Windows`
        ]
      : [])
  ];
}

/** Why a listed answer keeps the recording provisional. */
function notReplayableWhy(
  header: FrozenHeader,
  lines: readonly FrozenExchange[]
): string | null {
  const listed = header.notReplayable ?? [];
  if (!listed.length) return null;
  const named = listed.map((entry) => {
    const line = lines.find((l) => l.key === entry.key);
    return `${line ? `${line.method} ${line.path}` : entry.key}, ${(entry.fields ?? []).join(', ')}`;
  });
  return `${listed.length} ${listed.length === 1 ? 'answer' : 'answers'} can't replay (notReplayable: ${named.join('; ')})`;
}

/**
 * Why `--frozen-reviewed` doesn't name this recording's reviewed build,
 * or null when it does: `<commit>@<sha256>`, the header's validatorCommit
 * and the hash of the binary that replayed it (the header's hash for this
 * platform).
 */
export function reviewedProblem(
  reviewed: string | undefined,
  header: FrozenHeader,
  binarySha256: string
): string | null {
  const named = `${header.validatorCommit}@${binarySha256}`;
  if (!reviewed) {
    return `its build (${named}) isn't named as reviewed (--frozen-reviewed <commit>@<sha256>)`;
  }
  return reviewed === named
    ? null
    : `--frozen-reviewed names ${reviewed}, not this recording's build ${named}`;
}

/**
 * The text with each named folder, written with either slash and in any
 * case, replaced by its label, then the machine's temp and home folders,
 * so a report quotes no local path.
 */
export function redactPaths(
  text: string,
  folders: Readonly<Record<string, string>>
): string {
  const named: [string, string][] = [
    ...Object.entries(folders),
    ['<temp>', os.tmpdir()],
    ['~', os.homedir()]
  ];
  let out = text;
  for (const [label, folder] of named) {
    const parts = path.resolve(folder).split(/[\\/]/);
    // Either slash between the folder's parts, any case.
    const pattern = parts
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]');
    out = out.replace(new RegExp(pattern, 'gi'), label);
  }
  return out;
}

/** A folder `name` inside `workDir`, or null when it would be outside. */
function workFolder(workDir: string, name: string): string | null {
  const root = path.resolve(workDir);
  const folder = path.resolve(root, name);
  return folder.startsWith(root + path.sep) ? folder : null;
}

/**
 * All three checks for a recording made through the frozen node. Without
 * a validator the copies aren't re-served, and without `--frozen-reviewed`
 * naming the capture's commit and the replay binary's hash the recording
 * isn't final; either leaves it provisional, with the reason. The copies
 * are unpacked under `workDir`, a folder of the run's own, and nothing
 * outside it is written or removed.
 */
export async function verifyFrozenRecording(options: {
  readonly dir: string;
  readonly header: FrozenHeader;
  readonly lines: readonly FrozenExchange[];
  readonly workDir: string;
  readonly validator?: FrozenValidator;
  readonly port?: number;
  /** `<commit>@<sha256>`: see reviewedProblem. */
  readonly reviewed?: string;
  readonly lockDir?: string;
}): Promise<FrozenVerdict> {
  const problems = frozenHeaderProblems(options.header, options.lines);
  if (problems.length) {
    return {
      problems,
      provisionalWhy: 'its frozen-snapshot header fails its checks'
    };
  }
  if (!options.validator || !options.port) {
    return {
      problems: [],
      provisionalWhy:
        'frozen copies not re-served: no --validator-bin and --frozen-port'
    };
  }
  const binary = validatorProblems(options.validator, options.header);
  if (binary.length) {
    return {
      problems: binary,
      provisionalWhy: 'its validator fails its checks'
    };
  }
  const binarySha256 = options.header[replayHashField()] as string;
  const notes = frozenNotes(options.header, process.platform, binarySha256);
  const verdict = await reServe(options, options.validator, options.port);
  if (verdict) return { ...verdict, notes };
  const retagged = options.header.retagged ?? [];
  const why = [
    ...(retagged.length
      ? [
          `${retagged.length} answers were tagged with their snapshot after the capture (retagged), so the recording can't be final`
        ]
      : []),
    notReplayableWhy(options.header, options.lines),
    options.header.devnetSha256
      ? null
      : "the header doesn't name devnetSha256, so its devnet.toml isn't tied to the capture",
    reviewedProblem(options.reviewed, options.header, binarySha256)
  ].filter((reason): reason is string => !!reason);
  return {
    problems: [],
    provisionalWhy: why.length ? why.join('; ') : null,
    notes
  };
}

/**
 * Check 3: each snapshot's kept copy re-served and its answers replayed.
 * A verdict when something fails, else null.
 */
async function reServe(
  options: Parameters<typeof verifyFrozenRecording>[0],
  validator: FrozenValidator,
  port: number
): Promise<FrozenVerdict | null> {
  // The copies' configs name their genesis as ../devnet.toml.
  const devnet = path.join(options.dir, 'devnet.toml');
  if (!fs.existsSync(devnet)) {
    return {
      problems: [
        "the recording has no devnet.toml, which its copies' configs name"
      ],
      provisionalWhy: 'a kept copy fails its checks'
    };
  }
  if (
    options.header.devnetSha256 &&
    sha256(fs.readFileSync(devnet)) !== options.header.devnetSha256
  ) {
    return {
      problems: [
        "the recording's devnet.toml doesn't match its hash in the header"
      ],
      provisionalWhy: 'a kept copy fails its checks'
    };
  }
  // An answer tagged after the capture may not be the snapshot's: it is
  // left out of the replay, and the recording can't be final.
  const retaggedKeys = new Set(
    (options.header.retagged ?? []).map((entry) => entry.key)
  );
  // A listed answer is replayed too, compared without its fields.
  const masked = new Map(
    (options.header.notReplayable ?? []).map((entry) => [
      entry.key ?? '',
      entry.fields ?? []
    ])
  );
  // Errors from unpacking and from the node name the run's folders: the
  // report gets them without the machine's paths.
  const redact = (message: string) =>
    redactPaths(message, {
      '<work folder>': options.workDir,
      '<recording>': options.dir
    });
  const snapshots = options.header.frozen ?? [];
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    // Folders by position, not by phase name: no name a file system reads
    // specially, and no two phases that differ only in case share one.
    // Each must still be inside the work folder before anything there is
    // removed.
    const base = workFolder(options.workDir, `snapshot-${index + 1}`);
    if (!base) {
      return {
        problems: [
          `snapshot ${snapshot.phase}: its folder would be outside the work folder`
        ],
        provisionalWhy: 'a kept copy could not be re-served'
      };
    }
    const folder = path.join(base, 'data');
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    fs.mkdirSync(base, { recursive: true });
    fs.copyFileSync(devnet, path.join(base, 'devnet.toml'));
    try {
      unpackSnapshot(options.dir, snapshot, folder);
    } catch (error) {
      return {
        problems: [redact((error as Error).message)],
        provisionalWhy: 'a kept copy fails its checks'
      };
    }
    let node: FrozenNode;
    try {
      node = await startFrozenNode({
        validator,
        folder,
        port,
        tmpDir: path.join(base, 'tmp'),
        logFile: path.join(base, 'frozen-node.log'),
        lockDir: options.lockDir,
        redact
      });
    } catch (error) {
      return {
        problems: [
          `snapshot ${snapshot.phase}: ${redact((error as Error).message)}`
        ],
        provisionalWhy: 'a kept copy could not be re-served'
      };
    }
    try {
      const status = await statusProblems(node.url, snapshot);
      const replay = status.length
        ? { replayed: 0, problems: [] }
        : await replaySnapshot(
            node.url,
            options.lines.filter(
              (line) =>
                line.snapshot === snapshot.phase && !retaggedKeys.has(line.key)
            ),
            masked
          );
      const failed = [...status, ...replay.problems];
      if (failed.length) {
        return { problems: failed, provisionalWhy: "its answers don't replay" };
      }
    } finally {
      await node.stop();
    }
  }
  return null;
}
