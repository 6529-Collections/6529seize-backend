import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  ChainGatewayClient,
  chainGatewayConfigFromEnv
} from '@/chain-gateway/chain-gateway.client';
import {
  exchangeKey,
  RecordedExchange
} from '@/rebuild/sources/http-recording';
import {
  closeServer,
  listenLoopback,
  readBody,
  writeProvenance
} from '@/rebuild/sources/running-source';
import {
  firstFinalizedFrom,
  gatewayChainIndexSource,
  indexChainTo
} from '@/rebuild/steps/waves-chain-index.steps';
import { FakeIndexDb } from '@/tests/fixtures/waves-chain-index.fixture';

/**
 * Records, from a devnet's API-mode node, every gateway answer the waves
 * rebuild reads, so a run replays them (`--source gateway=replay:<dir>`).
 *
 * The rebuild reads at two heights: the first finalized height at or after
 * the one the waves import completed at, and the mark. A node keeps only
 * its last few heights, so the capture reads the first as soon as the
 * import is final (phase 1), then
 * waits until the native writes are final (phase 2): the node's finalized
 * height then is the mark, read once and kept as the recording's
 * /v1/status. Phase 2 reads from empty, as a rebuild does: what phase 1
 * recorded is answered from the recording, the rest from the node.
 *
 * Then the chain mirror's own reads beyond the index, as the mirror makes
 * them (the gateway client, pinned at the mark): the block of every
 * height a recorded vote, result or policy names (`/v1/blocks/{h}`, its
 * time), and each chain-made decision's policies
 * (`/v1/decisions/{id}/policies`) and the blocks of their activation
 * heights. A block the mirror finds in the index is asked for here too:
 * an extra answer is harmless, a missing one is not.
 *
 * Documents are not recorded: a rebuild reads them from the capture's
 * files directory (files named by CID), and a frozen node has no document
 * store, so a recorded /v1/docs answer (its 404) would answer before the
 * files on replay. The recorder passes /v1/docs reads through and keeps
 * none of them.
 *
 * The index runs in memory: the capture needs the node, Node.js and this
 * repository's code, not MySQL.
 */
export interface GatewayCaptureOptions {
  /** The API-mode node's base URL (loopback on the devnet). */
  readonly gateway: string;
  readonly dir: string;
  /** How the recording was made, for PROVENANCE.json. */
  readonly madeBy: string;
  /** Resolves when the native writes are final: phase 2 starts. */
  readonly waitForMark: () => Promise<void>;
  readonly pollMs?: number;
  readonly log?: (message: string) => void;
}

export interface GatewayCaptureResult {
  readonly doneHeight: number;
  /** The first finalized height at or after doneHeight: the index's start. */
  readonly startHeight: number;
  readonly markHeight: number;
  readonly exchanges: number;
  /** The chain mirror's reads: blocks and decisions' policies asked. */
  readonly mirrorReads: { readonly blocks: number; readonly policies: number };
}

const RECORDING_FILE = 'recording.jsonl';
const STATUS_PATH = '/v1/status';
/** The document store's route: passed through, never recorded. */
const DOCS_PATH = '/v1/docs';

function isDocumentRead(url: string): boolean {
  const route = url.split('?')[0];
  return route === DOCS_PATH || route.startsWith(`${DOCS_PATH}/`);
}

/** An answer that isn't text is kept as base64, byte for byte. */
function bodyOf(
  bytes: Buffer,
  contentType: string | null
): Pick<RecordedExchange, 'body' | 'encoding'> {
  const text = /json|text|xml/i.test(contentType ?? '') || !contentType;
  return text
    ? { body: bytes.toString('utf8'), encoding: 'utf8' }
    : { body: bytes.toString('base64'), encoding: 'base64' };
}

/**
 * The upstream gateway the capture reads: an http or https address the
 * caller names, with no credentials, query or fragment. The recorder sends
 * nothing to any other origin.
 */
export function gatewayBase(upstream: string): URL {
  const base = new URL(upstream);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`The gateway ${upstream} is not an http or https address`);
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    /[?#]/.test(upstream)
  ) {
    throw new Error(
      `The gateway ${upstream} must be an origin and path, with no credentials, query or fragment`
    );
  }
  return base;
}

/**
 * A recorded request's address on the upstream: the gateway's path with
 * the request's path and query after it, on the gateway's own origin and
 * under its path. Null for anything that isn't an absolute path, or that
 * resolves outside the gateway's path (dot segments, encoded or not).
 */
export function upstreamTarget(base: URL, requestUrl: string): URL | null {
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return null;
  const query = requestUrl.indexOf('?');
  const requestPath = query === -1 ? requestUrl : requestUrl.slice(0, query);
  const target = new URL(base.href);
  target.pathname = `${base.pathname.replace(/\/$/, '')}${requestPath}`;
  target.search = query === -1 ? '' : requestUrl.slice(query);
  const prefix = base.pathname.replace(/\/$/, '');
  const underBase =
    target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
  return target.origin === base.origin && underBase ? target : null;
}

/** Forwards to the node and keeps what it answered, by the harness's key. */
export async function startRecorder(upstream: string, dir: string) {
  const base = gatewayBase(upstream);
  const file = path.join(dir, RECORDING_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '');
  const kept = new Map<string, RecordedExchange>();
  const state = { keepStatus: false };
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const method = request.method ?? 'GET';
      const url = request.url ?? '/';
      const key = exchangeKey(method, url, body);
      const isStatus = url.split('?')[0] === STATUS_PATH;
      let exchange = kept.get(key);
      if (!exchange) {
        const target = upstreamTarget(base, url);
        if (!target)
          throw new Error(`The request ${url} is not a gateway path`);
        const answer = await fetch(target, {
          method,
          headers: {
            accept: String(request.headers.accept ?? 'application/json')
          },
          body: body.length ? body : undefined
        });
        const contentType = answer.headers.get('content-type');
        exchange = {
          key,
          method,
          path: url,
          status: answer.status,
          contentType,
          ...bodyOf(Buffer.from(await answer.arrayBuffer()), contentType)
        };
        // The status is kept once, at the mark: before it, the node's
        // finalized height is not the mark's.
        // A node's passing failure (a 5xx or 429) is answered but never
        // kept, so a retry asks the node again.
        const transient = exchange.status >= 500 || exchange.status === 429;
        if (
          (!isStatus || state.keepStatus) &&
          !isDocumentRead(url) &&
          !transient
        ) {
          kept.set(key, exchange);
          fs.appendFileSync(file, `${JSON.stringify(exchange)}\n`);
        }
      }
      response.writeHead(exchange.status, {
        'content-type': exchange.contentType ?? 'application/json'
      });
      response.end(Buffer.from(exchange.body, exchange.encoding));
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const { url } = await listenLoopback(server);
  return { url, state, kept, stop: () => closeServer(server) };
}

/** Height fields whose blocks the chain mirror may ask for. */
const HEIGHT_FIELDS = new Set([
  'updatedHeight',
  'settledHeight',
  'activationHeight'
]);

function positiveHeight(value: unknown): number | null {
  const height =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(height) && height > 0 ? height : null;
}

/** Every height named in a field the chain mirror reads a block for. */
function heightsIn(value: unknown, into: Set<number>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => heightsIn(item, into));
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      const height = HEIGHT_FIELDS.has(name) ? positiveHeight(item) : null;
      if (height !== null) into.add(height);
      else heightsIn(item, into);
    }
  }
}

/** Every decision made on the chain (origin native) in an answer. */
function nativeDecisionsIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => nativeDecisionsIn(item, into));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.decisionId === 'string' && record.origin === 'native') {
      into.add(record.decisionId.toLowerCase());
    }
    Object.values(record).forEach((item) => nativeDecisionsIn(item, into));
  }
}

/**
 * What the chain mirror reads beyond the index, from the recorded
 * answers: the heights of votes, results and policies, and the decisions
 * made on the chain, each once and in order.
 */
export function mirrorReadTargets(
  exchanges: Iterable<Pick<RecordedExchange, 'body' | 'encoding'>>
): { heights: number[]; decisions: string[] } {
  const heights = new Set<number>();
  const decisions = new Set<string>();
  for (const exchange of Array.from(exchanges)) {
    if (exchange.encoding !== 'utf8') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(exchange.body);
    } catch {
      continue;
    }
    heightsIn(parsed, heights);
    nativeDecisionsIn(parsed, decisions);
  }
  return {
    heights: Array.from(heights).sort((a, b) => a - b),
    decisions: Array.from(decisions).sort((a, b) =>
      a < b ? -1 : Number(a > b)
    )
  };
}

/**
 * The chain mirror's reads beyond the index, through the recorder with the
 * same client the mirror uses, so each answer is kept under the key the
 * mirror's replayed read asks for: each chain-made decision's policies,
 * then the block of every height found. The node's "not found" is kept as
 * an answer; any other failure, after the client's own retries, fails the
 * capture, so a recording never keeps a node error for good.
 */
export async function readMirrorExtras(
  recorderUrl: string,
  exchanges: () => Iterable<Pick<RecordedExchange, 'body' | 'encoding'>>
): Promise<{ blocks: number; policies: number }> {
  const client = new ChainGatewayClient(() =>
    chainGatewayConfigFromEnv({ CHAIN_GATEWAY_URL: recorderUrl })
  );
  const read = async (path: string) => {
    try {
      await client.read(path);
    } catch (error) {
      throw new Error(
        `The capture of the mirror's read ${path} failed: ${error}`
      );
    }
  };
  const { decisions } = mirrorReadTargets(exchanges());
  for (const decisionId of decisions) {
    await read(`/v1/decisions/${decisionId}/policies`);
  }
  // The policies' activation heights are among the heights now.
  const { heights } = mirrorReadTargets(exchanges());
  for (const height of heights) {
    await read(`/v1/blocks/${height}`);
  }
  return { blocks: heights.length, policies: decisions.length };
}

async function json(url: string): Promise<Record<string, unknown> | null> {
  const answer = await fetch(url, { headers: { accept: 'application/json' } });
  return answer.ok ? ((await answer.json()) as Record<string, unknown>) : null;
}

/**
 * The waves import's completion height, once the node has finalized it:
 * the import's state and the status read unpinned (the node's latest
 * finalized height), every `pollMs`.
 */
async function waitForImport(
  gateway: string,
  pollMs: number,
  log: (message: string) => void
): Promise<number> {
  const base = gateway.replace(/\/$/, '');
  for (;;) {
    const status = (await json(`${base}${STATUS_PATH}`))?.data as
      | { finalized?: { height?: number } }
      | undefined;
    const finalized = Number(status?.finalized?.height);
    const imported = (await json(`${base}/v1/waves/import`))?.data as
      | { completed?: boolean; doneHeight?: number }
      | undefined;
    const done = Number(imported?.doneHeight);
    if (
      imported?.completed === true &&
      Number.isSafeInteger(done) &&
      Number.isSafeInteger(finalized) &&
      finalized >= done
    ) {
      log(
        `[GATEWAY CAPTURE] waves import done at ${done}, finalized ${finalized}`
      );
      return done;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function captureWavesGateway(
  options: GatewayCaptureOptions
): Promise<GatewayCaptureResult> {
  const log = options.log ?? (() => undefined);
  const recorder = await startRecorder(options.gateway, options.dir);
  try {
    const doneHeight = await waitForImport(
      options.gateway,
      options.pollMs ?? 2000,
      log
    );
    // Phase 1: everything at the first finalized height at or after the
    // import's (it may not be finalized itself), while the node holds it.
    const source = gatewayChainIndexSource(recorder.url);
    const start = await firstFinalizedFrom(
      source,
      doneHeight,
      await source.finalizedHeight()
    );
    await indexChainTo(source, new FakeIndexDb().asDb(), start.finalizedHeight);
    log(
      `[GATEWAY CAPTURE] phase 1 done at ${start.finalizedHeight}: ${recorder.kept.size} answers`
    );
    await options.waitForMark();
    // Phase 2: as a rebuild reads, from empty, to the node's finalized
    // height now (the mark), kept as the recording's status.
    recorder.state.keepStatus = true;
    const heights = await indexChainTo(
      gatewayChainIndexSource(recorder.url),
      new FakeIndexDb().asDb(),
      null
    );
    const markHeight = heights[heights.length - 1];
    if (heights[0] !== start.finalizedHeight || markHeight === undefined) {
      throw new Error(
        `The rebuild's heights ${heights.join(', ')} don't start at phase 1's ${start.finalizedHeight}`
      );
    }
    // Phase 3: the chain mirror's own reads, pinned at the mark as well.
    const mirrorReads = await readMirrorExtras(recorder.url, () =>
      recorder.kept.values()
    );
    writeProvenance(options.dir, {
      made_by: options.madeBy,
      note: `The waves import completed at height ${doneHeight}; the index starts at ${start.finalizedHeight}, the first finalized height from it; the mark is height ${markHeight}.`,
      recorded_at: new Date().toISOString()
    });
    log(
      `[GATEWAY CAPTURE] done: ${recorder.kept.size} answers, import ${doneHeight}, heights ${start.finalizedHeight} and ${markHeight}, the mirror's reads: ${mirrorReads.blocks} blocks, ${mirrorReads.policies} decisions' policies`
    );
    return {
      doneHeight,
      startHeight: start.finalizedHeight,
      markHeight,
      exchanges: recorder.kept.size,
      mirrorReads
    };
  } finally {
    await recorder.stop();
  }
}

function argOf(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

// `... gateway-capture.ts --gateway <url> --dir <dir> --made-by <text>`:
// phase 2 starts when <dir>/MARK exists (create it once the native writes
// are final).
if (require.main === module) {
  const args = process.argv.slice(2);
  const gateway = argOf(args, '--gateway');
  const dir = argOf(args, '--dir');
  const madeBy = argOf(args, '--made-by');
  if (!gateway || !dir || !madeBy) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: gateway-capture --gateway <url> --dir <dir> --made-by <text>'
    );
    process.exit(2);
  }
  const markFile = path.join(dir, 'MARK');
  // eslint-disable-next-line no-console
  const log = (message: string) => console.log(message);
  captureWavesGateway({
    gateway,
    dir,
    madeBy,
    log,
    waitForMark: async () => {
      log(`[GATEWAY CAPTURE] waiting for ${markFile}`);
      while (!fs.existsSync(markFile)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      fs.rmSync(markFile);
    }
  })
    .then(() => process.exit(0))
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}
