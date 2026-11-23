import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { exchangeKey, parseJson } from '@/rebuild/sources/exchange-key';
import {
  closeServer,
  listenLoopback,
  readBody,
  readProvenance,
  redactUrl,
  RunningSource,
  writeProvenance
} from '@/rebuild/sources/running-source';
import { UrlSource } from '@/rebuild/sources/source-spec';
import {
  FrozenHeader,
  FrozenValidator,
  verifyFrozenRecording
} from '@/rebuild/sources/frozen-gateway';

/** How a run re-serves a frozen recording's copies. */
export interface FrozenOptions {
  readonly validator?: FrozenValidator;
  /** A 127.0.0.1 port claimed for the frozen node. */
  readonly port?: number;
  /**
   * The reviewed build, `<commit>@<sha256>`: the capture's commit and the
   * replay binary's hash. With it a recording that passes can be final.
   */
  readonly reviewed?: string;
  /** Where the copies are unpacked: a folder of the run's own. */
  readonly workDir?: string;
}

const RECORDING_FILE = 'recording.jsonl';

export { exchangeKey };

type Json = unknown;

/** One saved answer. JSON-RPC ids are left out of the key and put back. */
export interface RecordedExchange {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly encoding: 'utf8' | 'base64';
}

/** Puts the request's JSON-RPC ids into a recorded response. */
export function withRequestIds(
  requestBody: Buffer,
  responseBody: string
): string {
  const request = parseJson(requestBody);
  let response: Json;
  try {
    response = JSON.parse(responseBody);
  } catch {
    return responseBody;
  }
  if (Array.isArray(request) && Array.isArray(response)) {
    return JSON.stringify(
      response.map((item, i) =>
        item &&
        typeof item === 'object' &&
        request[i] &&
        typeof request[i] === 'object'
          ? { ...item, id: (request[i] as { id?: unknown }).id }
          : item
      )
    );
  }
  if (
    request &&
    typeof request === 'object' &&
    response &&
    typeof response === 'object' &&
    'jsonrpc' in (request as object)
  ) {
    return JSON.stringify({
      ...(response as object),
      id: (request as { id?: unknown }).id
    });
  }
  return responseBody;
}

/** Every line of a recording, repeats included, in file order. */
function readRecordingLines(dir: string): RecordedExchange[] {
  const file = path.join(dir, RECORDING_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordedExchange);
}

function textBody(buffer: Buffer, contentType: string | null) {
  const text = /json|text|xml/i.test(contentType ?? '') || !contentType;
  return text
    ? { body: buffer.toString('utf8'), encoding: 'utf8' as const }
    : { body: buffer.toString('base64'), encoding: 'base64' as const };
}

async function forward(
  upstream: string,
  request: http.IncomingMessage,
  body: Buffer
): Promise<{ status: number; contentType: string | null; body: Buffer }> {
  const response = await fetch(`${upstream.replace(/\/$/, '')}${request.url}`, {
    method: request.method,
    headers: {
      'content-type': String(
        request.headers['content-type'] ?? 'application/json'
      ),
      accept: String(request.headers.accept ?? '*/*')
    },
    body: body.length ? body : undefined
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer())
  };
}

/**
 * Serves a recording (replay) or proxies to `upstream` and saves each new
 * answer (record). In replay an unrecorded request answers 599 and is
 * reported, so a run never silently reaches past its recording.
 *
 * A label is never a basis: a recording is provisional whatever its
 * PROVENANCE.json says, unless the run verifies its answers. A gateway
 * recording made through the frozen-snapshot node can be (see
 * frozen-gateway.ts); nothing verifies an Ethereum node's answers yet
 * (the blocks' hash chain and receipt proofs).
 */

export async function startHttpRecording(options: {
  readonly name: UrlSource;
  readonly dir: string;
  readonly upstream?: string;
  /**
   * For a replayed recording whose PROVENANCE.json names frozen
   * snapshots: how to re-serve them, and the reviewed build.
   */
  readonly frozen?: FrozenOptions;
}): Promise<RunningSource> {
  const lines = readRecordingLines(options.dir);
  const recording = new Map(lines.map((line) => [line.key, line]));
  const header = readProvenance(options.dir) as FrozenHeader | null;
  // A frozen recording holds the snapshots' answers only: recording into
  // it would add answers no snapshot served.
  if (options.upstream && header?.frozen) {
    throw new Error(
      `${options.name}: a frozen-snapshot recording can't be recorded into`
    );
  }
  const frozen = !header?.frozen
    ? null
    : options.frozen?.workDir
      ? await verifyFrozenRecording({
          dir: options.dir,
          header,
          lines,
          workDir: options.frozen.workDir,
          validator: options.frozen.validator,
          port: options.frozen.port,
          reviewed: options.frozen.reviewed
        })
      : {
          problems: ['no work folder was given for its frozen copies'],
          provisionalWhy: 'its frozen copies have no work folder'
        };
  const unrecorded: string[] = [];
  // Recording adds to the files; a recording someone marked as written by
  // hand stays marked so, whatever this run adds to it.
  if (options.upstream && readProvenance(options.dir)?.made_by !== 'hand') {
    writeProvenance(options.dir, {
      made_by: `record of ${redactUrl(options.upstream)}`,
      recorded_at: new Date().toISOString()
    });
  }
  const provenance = readProvenance(options.dir);
  const server = http.createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const key = exchangeKey(
        request.method ?? 'GET',
        request.url ?? '/',
        body
      );
      let exchange = recording.get(key);
      if (!exchange && options.upstream) {
        const answer = await forward(options.upstream, request, body);
        exchange = {
          key,
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          status: answer.status,
          contentType: answer.contentType,
          ...textBody(answer.body, answer.contentType)
        };
        recording.set(key, exchange);
        fs.appendFileSync(
          path.join(options.dir, RECORDING_FILE),
          `${JSON.stringify(exchange)}\n`
        );
      }
      if (!exchange) {
        unrecorded.push(`${request.method} ${request.url}`);
        response.writeHead(599, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not in the recording' }));
        return;
      }
      const payload =
        exchange.encoding === 'base64'
          ? Buffer.from(exchange.body, 'base64')
          : Buffer.from(withRequestIds(body, exchange.body), 'utf8');
      response.writeHead(exchange.status, {
        'content-type': exchange.contentType ?? 'application/json'
      });
      response.end(payload);
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  const { url } = await listenLoopback(server);
  return {
    name: options.name,
    url,
    info: {
      url,
      mode: options.upstream ? 'record' : 'replay',
      provenance: provenance?.made_by ?? null,
      ...(frozen
        ? frozen.provisionalWhy
          ? { provisional: true, provisionalWhy: frozen.provisionalWhy }
          : { provisional: false }
        : { provisional: true, provisionalWhy: 'answers not verified' }),
      ...(frozen?.notes?.length ? { notes: frozen.notes } : {})
    },
    problems: () => [
      ...(frozen?.problems ?? []).map(
        (problem) => `${options.name}: frozen snapshot check: ${problem}`
      ),
      ...(unrecorded.length
        ? [
            `${options.name}: ${unrecorded.length} requests not in the recording, first ${unrecorded.slice(0, 5).join(', ')}`
          ]
        : [])
    ],
    stop: () => closeServer(server)
  };
}
