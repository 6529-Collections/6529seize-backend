import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  loopbackPort,
  peerSettings,
  withLoopbackListen
} from '@/rebuild/sources/frozen-config';
import { takeFrozenLock } from '@/rebuild/sources/frozen-guard';
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
 * A recording whose header or copies don't hold up fails the run. One the
 * run can't re-serve (no validator given) or that no reviewer has scored
 * stays provisional, with the reason.
 */

export const FROZEN_OPTION = 'validator run --api-frozen-snapshot';

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
  /** Answers whose snapshot tag was set after the capture. */
  readonly retagged?: readonly { readonly key?: string }[];
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
  const snapshots = header.frozen ?? [];
  if (!snapshots.length) return ['the header names no frozen snapshot'];
  // The build that served the capture, and the same build for re-serving
  // the copies here.
  if (!COMMIT.test(header.validatorCommit ?? '')) {
    problems.push('the header names no full validatorCommit');
  }
  for (const field of [
    'validatorSha256Linux',
    'validatorSha256Windows'
  ] as const) {
    if (!HEX64.test(header[field] ?? '')) {
      problems.push(`the header names no ${field}`);
    }
  }
  const phases = new Set<string>();
  for (const s of snapshots) {
    const at = `snapshot ${s.phase ?? '(no phase)'}`;
    if (!s.phase) problems.push('a snapshot has no phase');
    else if (phases.has(s.phase)) problems.push(`${at} appears twice`);
    phases.add(s.phase);
    if (s.option !== FROZEN_OPTION) {
      problems.push(`${at} wasn't served by ${FROZEN_OPTION}`);
    }
    if (!Number.isInteger(s.height) || s.height <= 0) {
      problems.push(`${at} names no height`);
    }
    if (!ROOT.test(s.blockRoot ?? ''))
      problems.push(`${at} names no block root`);
    if (!ROOT.test(s.appStateRoot ?? '')) {
      problems.push(`${at} names no app state root`);
    }
    if (!HEX64.test(s.dataDirSha256 ?? '')) {
      problems.push(`${at} names no data-dir copy hash`);
    } else if (s.dataDirArchive !== `${s.dataDirSha256}.tar.gz`) {
      problems.push(`${at}'s archive isn't named by the copy's hash`);
    }
    if (!HEX64.test(s.dataDirArchiveSha256 ?? '')) {
      problems.push(`${at} names no archive hash`);
    }
    if (!s.copiedNode) problems.push(`${at} doesn't name the copied node`);
    const live = s.liveNodes ?? [];
    const others = live.filter((n) => n.node && n.node !== s.copiedNode);
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
  const untagged = lines.filter((l) => !l.snapshot || !phases.has(l.snapshot));
  if (untagged.length) {
    problems.push(
      `${untagged.length} answers name no snapshot of the header, first ${untagged[0].method} ${untagged[0].path}`
    );
  }
  if (
    header.answers !== lines.length ||
    header.answersServedFrozen !== lines.length
  ) {
    problems.push(
      `the header counts ${header.answers} answers, ${header.answersServedFrozen} served frozen, for ${lines.length} recorded`
    );
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
      `snapshot ${snapshot.phase}: no kept copy at ${archiveFile}`
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

/** The binary's hash and its frozen option, against the header. */
export function validatorProblems(
  validator: FrozenValidator,
  header: FrozenHeader,
  platform: NodeJS.Platform = process.platform
): string[] {
  // Both builds of one commit answer with the same bytes: the status's
  // node field is the release, not the platform.
  const field =
    platform === 'win32' ? 'validatorSha256Windows' : 'validatorSha256Linux';
  const expected = header[field];
  if (!expected) return [`the header names no ${field}`];
  if (!fs.existsSync(validator.file)) {
    return [`no validator at ${validator.file}`];
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

/** The answers' request body: empty, or the recorded JSON. */
function requestBody(exchange: FrozenExchange): string | undefined | null {
  // The key is the method, the path with its query sorted, then the body.
  const afterMethod = exchange.key.indexOf(' ') + 1;
  const text = exchange.key.slice(exchange.key.indexOf(' ', afterMethod) + 1);
  if (text === sha256(Buffer.alloc(0))) return undefined;
  return text.startsWith('{') || text.startsWith('[') ? text : null;
}

export interface ReplayOutcome {
  readonly replayed: number;
  readonly problems: string[];
}

/**
 * Replays one snapshot's answers against a frozen node at `url`: each
 * must come back with the recorded status, content type and bytes.
 */
export async function replaySnapshot(
  url: string,
  exchanges: readonly FrozenExchange[]
): Promise<ReplayOutcome> {
  const problems: string[] = [];
  let replayed = 0;
  for (const exchange of exchanges) {
    const body = requestBody(exchange);
    if (body === null) {
      problems.push(
        `${exchange.method} ${exchange.path}: its request body isn't recorded, so it can't be replayed`
      );
      continue;
    }
    const response = await fetch(`${url}${exchange.path}`, {
      method: exchange.method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const recorded =
      exchange.encoding === 'base64'
        ? Buffer.from(exchange.body, 'base64')
        : Buffer.from(exchange.body, 'utf8');
    replayed++;
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
 */
export async function startFrozenNode(options: {
  readonly validator: FrozenValidator;
  readonly folder: string;
  readonly port: number;
  readonly tmpDir: string;
  readonly logFile: string;
  readonly lockDir?: string;
  readonly readyTimeoutMs?: number;
}): Promise<FrozenNode> {
  const configFile = path.join(options.folder, 'config.toml');
  if (!fs.existsSync(configFile)) {
    throw new Error(`the copy has no config.toml at ${configFile}`);
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
  fs.mkdirSync(options.tmpDir, { recursive: true });
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const log = fs.openSync(options.logFile, 'a');
  const [program, ...args] = options.validator.command;
  const child = spawn(
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
  let output = '';
  const note = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    fs.writeSync(log, chunk);
  };
  child.stdout.on('data', note);
  child.stderr.on('data', note);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const stop = async () => {
    // Our own child, by its own handle: never a process found by name.
    if (!exited) {
      child.kill();
      await new Promise<void>((resolve) => {
        if (exited) resolve();
        else child.once('exit', () => resolve());
      });
    }
    fs.closeSync(log);
    fs.rmSync(options.tmpDir, { recursive: true, force: true });
    lock.release();
  };
  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 300_000);
  try {
    for (;;) {
      if (exited)
        throw new Error(`the frozen node exited: ${output.trim().slice(-300)}`);
      if (/serves .* on /.test(output)) {
        if (!output.includes(` on 127.0.0.1:${options.port}`)) {
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
}

/**
 * All three checks for a recording made through the frozen node. Without
 * a validator the copies aren't re-served, and without the review flag
 * naming the capture's commit the recording isn't final; either leaves it
 * provisional, with the reason.
 */
export async function verifyFrozenRecording(options: {
  readonly dir: string;
  readonly header: FrozenHeader;
  readonly lines: readonly FrozenExchange[];
  readonly workDir: string;
  readonly validator?: FrozenValidator;
  readonly port?: number;
  readonly reviewedCommit?: string;
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
  // An answer tagged after the capture may not be the snapshot's: it is
  // left out of the replay, and the recording can't be final.
  const retaggedKeys = new Set(
    (options.header.retagged ?? []).map((entry) => entry.key)
  );
  const devnet = path.join(options.dir, 'devnet.toml');
  for (const snapshot of options.header.frozen ?? []) {
    // The copy's config names its genesis as ../devnet.toml.
    const base = path.join(options.workDir, snapshot.phase);
    const folder = path.join(base, 'data');
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    if (fs.existsSync(devnet))
      fs.copyFileSync(devnet, path.join(base, 'devnet.toml'));
    try {
      unpackSnapshot(options.dir, snapshot, folder);
    } catch (error) {
      return {
        problems: [(error as Error).message],
        provisionalWhy: 'a kept copy fails its checks'
      };
    }
    let node: FrozenNode;
    try {
      node = await startFrozenNode({
        validator: options.validator,
        folder,
        port: options.port,
        tmpDir: path.join(base, 'tmp'),
        logFile: path.join(base, 'frozen-node.log'),
        lockDir: options.lockDir
      });
    } catch (error) {
      return {
        problems: [`snapshot ${snapshot.phase}: ${(error as Error).message}`],
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
            )
          );
      const failed = [...status, ...replay.problems];
      if (failed.length) {
        return { problems: failed, provisionalWhy: "its answers don't replay" };
      }
    } finally {
      await node.stop();
    }
  }
  const retagged = options.header.retagged ?? [];
  if (retagged.length) {
    return {
      problems: [],
      provisionalWhy: `${retagged.length} answers were tagged with their snapshot after the capture (retagged), so the recording can't be final`
    };
  }
  if (options.reviewedCommit !== options.header.validatorCommit) {
    return {
      problems: [],
      provisionalWhy: `its validator (${options.header.validatorCommit ?? 'no commit named'}) isn't marked reviewed (--frozen-reviewed)`
    };
  }
  return { problems: [], provisionalWhy: null };
}
