import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { canonicalStringify } from '@/rebuild/probes/canonical';
import {
  closeServer,
  errorText,
  listenLoopback,
  readBody,
  readProvenance,
  redactUrl,
  RunningSource,
  writeProvenance
} from '@/rebuild/sources/running-source';
import { UrlSource } from '@/rebuild/sources/source-spec';

const RECORDING_FILE = 'recording.jsonl';

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

type Json = unknown;

function withoutIds(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === 'object' && 'jsonrpc' in value) {
    const { id: _id, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

function parseJson(body: Buffer): Json | undefined {
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function sortedQuery(rawPath: string): string {
  const [pathname, query] = rawPath.split('?');
  if (!query) return pathname;
  const params = query
    .split('&')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return `${pathname}?${params.join('&')}`;
}

/**
 * The key of a request: method, path with sorted query, and the body. A
 * JSON body is compared canonically, without JSON-RPC ids, since clients
 * number their requests differently on every run.
 */
export function exchangeKey(
  method: string,
  rawPath: string,
  body: Buffer
): string {
  const json = parseJson(body);
  const bodyText =
    json === undefined
      ? createHash('sha256').update(body).digest('hex')
      : canonicalStringify(withoutIds(json));
  return `${method} ${sortedQuery(rawPath)} ${bodyText}`;
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

/** The exchanges a recording holds, in the order it holds them. */
export function recordedExchanges(dir: string): RecordedExchange[] {
  return Array.from(loadRecording(dir).values());
}

function loadRecording(dir: string): Map<string, RecordedExchange> {
  const file = path.join(dir, RECORDING_FILE);
  const exchanges = new Map<string, RecordedExchange>();
  if (!fs.existsSync(file)) return exchanges;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const exchange = JSON.parse(line) as RecordedExchange;
    exchanges.set(exchange.key, exchange);
  }
  return exchanges;
}

function textBody(buffer: Buffer, contentType: string | null) {
  const text = /json|text|xml/i.test(contentType ?? '') || !contentType;
  return text
    ? { body: buffer.toString('utf8'), encoding: 'utf8' as const }
    : { body: buffer.toString('base64'), encoding: 'base64' as const };
}

/**
 * Where a recording run sends a request: the request's path and query on
 * the upstream's origin, under the upstream's path. Null for a request
 * target that isn't an absolute path (an absolute URL, `//host`, `@host`)
 * or that resolves outside the upstream's path through dot segments,
 * encoded or not, so no request can send the run to another host or path.
 */
export function upstreamTarget(upstream: URL, requestUrl: string): URL | null {
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return null;
  const query = requestUrl.indexOf('?');
  const requestPath = query === -1 ? requestUrl : requestUrl.slice(0, query);
  const prefix = upstream.pathname.replace(/\/$/, '');
  const target = new URL(upstream.href);
  target.pathname = `${prefix}${requestPath}`;
  // The upstream's own query (a key, say) stays, the request's after it.
  const asked = query === -1 ? '' : requestUrl.slice(query + 1);
  if (asked) {
    target.search = upstream.search
      ? `${upstream.search.slice(1)}&${asked}`
      : asked;
  }
  const underUpstream =
    target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
  return target.origin === upstream.origin && underUpstream ? target : null;
}

async function forward(
  target: URL,
  request: http.IncomingMessage,
  body: Buffer
): Promise<{ status: number; contentType: string | null; body: Buffer }> {
  const response = await fetch(target.href, {
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
 * reported, so a run never silently reaches past its recording. In record,
 * a request whose target isn't a path under the upstream (see
 * upstreamTarget) answers 400 and is reported, and nothing is fetched. A
 * request the server fails on answers 502 with a fixed message; the error
 * itself goes to the source's problems, so it reaches the run's report and
 * log.
 *
 * Nothing verifies a recording's answers yet, a gateway's or an Ethereum
 * node's, and a label is never a basis: a recording is provisional
 * whatever its PROVENANCE.json says. It can count once the run checks the
 * node's proofs (for Ethereum, the blocks' hash chain and receipt proofs).
 */

export async function startHttpRecording(options: {
  readonly name: UrlSource;
  readonly dir: string;
  readonly upstream?: string;
}): Promise<RunningSource> {
  const recording = loadRecording(options.dir);
  const unrecorded: string[] = [];
  const failed: string[] = [];
  const refused: string[] = [];
  const upstream = options.upstream ? new URL(options.upstream) : null;
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
    // The URL a recording run fetched, which an error may quote, key and all.
    let fetched: string | null = null;
    try {
      const body = await readBody(request);
      const key = exchangeKey(
        request.method ?? 'GET',
        request.url ?? '/',
        body
      );
      let exchange = recording.get(key);
      if (!exchange && upstream) {
        const target = upstreamTarget(upstream, request.url ?? '/');
        if (!target) {
          refused.push(`${request.method} ${request.url}`);
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: 'not a path under the upstream' })
          );
          return;
        }
        fetched = target.href;
        const answer = await forward(target, request, body);
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
      const text = [fetched, options.upstream].reduce<string>(
        (said, url) => (url ? said.split(url).join(redactUrl(url)) : said),
        errorText(error)
      );
      failed.push(`${request.method} ${request.url}: ${text}`);
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'replay failed' }));
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
      provisional: true,
      provisionalWhy: 'answers not verified'
    },
    problems: () => [
      ...(unrecorded.length
        ? [
            `${options.name}: ${unrecorded.length} requests not in the recording, first ${unrecorded.slice(0, 5).join(', ')}`
          ]
        : []),
      ...(failed.length
        ? [
            `${options.name}: ${failed.length} requests failed in the recording's server, first ${failed.slice(0, 3).join('; ')}`
          ]
        : []),
      ...(refused.length
        ? [
            `${options.name}: ${refused.length} requests refused, not a path under the upstream, first ${refused.slice(0, 3).join(', ')}`
          ]
        : [])
    ],
    stop: () => closeServer(server)
  };
}
