import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import fetch, { FetchError, Response } from 'node-fetch';
import type { AbortSignal as NodeFetchAbortSignal } from 'node-fetch/externals';
import { resolveHostAddresses } from '@/http/public-dns';
import { isPublicIpAddress } from '@/http/public-network-address';

/**
 * Shared transport for requests to URLs that come from outside the system
 * (token metadata, media sources, user-supplied links).
 *
 * Every hop is validated before it is sent: http/https only (optionally https
 * only), no userinfo, every DNS answer must be a public address, and the
 * address that was validated is pinned into the connection so the socket
 * cannot reach a different address than the one that was checked. Redirects
 * are followed manually and re-validated, response bodies are streamed with a
 * byte cap, and callers can bound both each hop and the whole exchange.
 */

export interface PinnedAddress {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PinnedResponse {
  readonly response: Response;
  /** Aborts the request and releases the socket. Safe to call repeatedly. */
  readonly cancel: () => void;
}

export interface OpenedPublicResponse extends PinnedResponse {
  /** URL of the request that produced `response`, after redirects. */
  readonly finalUrl: string;
}

export type PublicFetchMethod = 'GET' | 'HEAD';

export interface ResolvePublicTargetOptions {
  readonly signal?: AbortSignal;
  readonly httpsOnly?: boolean;
}

export interface OpenPublicResponseOptions extends ResolvePublicTargetOptions {
  readonly method?: PublicFetchMethod;
  readonly headers?: Record<string, string>;
  readonly maxRedirects: number;
  /** Per-hop limit until response headers arrive. */
  readonly requestTimeoutMs?: number;
  /** Overrides for callers that wrap the individual steps. */
  readonly resolveTarget?: (
    url: string,
    signal?: AbortSignal
  ) => Promise<PinnedAddress>;
  readonly sendRequest?: (
    url: string,
    pinned: PinnedAddress,
    signal?: AbortSignal
  ) => Promise<PinnedResponse>;
}

export interface PublicFetchOptions extends OpenPublicResponseOptions {
  /** Body cap; ignored for HEAD. */
  readonly maxBytes: number;
  /** Overall deadline for every hop and the body. */
  readonly timeoutMs?: number;
}

export interface PublicFetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Response['headers'];
  /** Empty for HEAD and for non-2xx responses. */
  readonly body: Buffer;
  readonly finalUrl: string;
}

export class PublicNetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, PublicNetworkPolicyError.prototype);
    this.name = 'PublicNetworkPolicyError';
  }
}

export class PublicResponseTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly observedBytes: number,
    readonly mode: 'content-length' | 'stream'
  ) {
    super(`Response exceeds byte limit (${observedBytes} > ${limitBytes})`);
    Object.setPrototypeOf(this, PublicResponseTooLargeError.prototype);
    this.name = 'PublicResponseTooLargeError';
  }
}

export class PublicFetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    Object.setPrototypeOf(this, PublicFetchTimeoutError.prototype);
    this.name = 'PublicFetchTimeoutError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization'
]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Validates the URL shape for a public request; does not touch the network. */
export function parsePublicTargetUrl(
  urlString: string,
  { httpsOnly = false }: { httpsOnly?: boolean } = {}
): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new PublicNetworkPolicyError('Invalid URL');
  }
  const allowed = httpsOnly ? ['https:'] : ['http:', 'https:'];
  if (!allowed.includes(parsed.protocol)) {
    throw new PublicNetworkPolicyError(
      `Unsupported URL protocol: ${parsed.protocol}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new PublicNetworkPolicyError('URLs with credentials are not allowed');
  }
  if (!parsed.hostname) {
    throw new PublicNetworkPolicyError('URL hostname is empty');
  }
  return parsed;
}

function dnsFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  switch (code) {
    case 'ETIMEOUT':
      return 'ETIMEDOUT';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
      return code;
    default:
      return 'EAI_AGAIN';
  }
}

async function resolveAddresses(hostname: string, signal?: AbortSignal) {
  try {
    return await resolveHostAddresses(hostname, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Same shape as a node-fetch connection failure so callers that classify
    // network errors keep treating DNS failures as network failures.
    throw new FetchError(`DNS lookup failed for ${hostname}`, 'system', {
      code: dnsFailureCode(error)
    } as never);
  }
}

/**
 * Resolves the URL's host and returns the address to connect to. Rejects
 * unless every DNS answer is a public address.
 */
export async function resolvePublicTarget(
  urlString: string,
  { signal, httpsOnly }: ResolvePublicTargetOptions = {}
): Promise<PinnedAddress> {
  const { hostname } = parsePublicTargetUrl(urlString, { httpsOnly });
  const records = await resolveAddresses(hostname, signal);
  if (!records.length) {
    throw new FetchError(`DNS lookup failed for ${hostname}`, 'system', {
      code: 'ENOTFOUND'
    } as never);
  }
  for (const record of records) {
    if (!isPublicIpAddress(record.address)) {
      throw new PublicNetworkPolicyError(
        `Blocked host ${hostname}; resolves to private/local address ${record.address}`
      );
    }
  }
  const selected = records[0];
  return {
    hostname,
    address: selected.address,
    family: selected.family === 6 ? 6 : 4
  };
}

/**
 * Indirection used by the transport for the validation step, so tests can
 * point requests at an owned local fixture without changing runtime policy.
 */
export const publicNetwork = {
  resolveTarget: resolvePublicTarget
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number
) => void;

export function createPinnedLookup(pinned: PinnedAddress) {
  return (
    hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: LookupCallback
  ): void => {
    const callback = (
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback
    ) as LookupCallback | undefined;
    const options = (
      typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {})
    ) as { family?: number | string; all?: boolean };
    if (typeof callback !== 'function') {
      throw new Error(`Pinned DNS lookup callback is missing`);
    }
    if (hostname !== pinned.hostname) {
      callback(
        new Error(
          `Pinned DNS lookup hostname mismatch: expected ${pinned.hostname}, got ${hostname}`
        )
      );
      return;
    }
    if (
      typeof options.family === 'number' &&
      options.family !== 0 &&
      options.family !== pinned.family
    ) {
      callback(
        new Error(
          `Pinned DNS family mismatch for ${hostname}: requested ${options.family}, pinned ${pinned.family}`
        )
      );
      return;
    }
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

export function createPinnedAgent(
  urlString: string,
  pinned: PinnedAddress
): http.Agent | https.Agent {
  const lookup = createPinnedLookup(pinned);
  if (new URL(urlString).protocol === 'https:') {
    const servername = pinned.hostname.replace(/^\[|\]$/g, '');
    return new https.Agent({
      keepAlive: false,
      lookup: lookup as never,
      // SNI must not carry an IP literal.
      ...(isIP(servername) ? {} : { servername })
    });
  }
  return new http.Agent({
    keepAlive: false,
    lookup
  } as http.AgentOptions & { lookup: typeof lookup });
}

/**
 * Sends one request (no redirect following) over a connection pinned to the
 * validated address. The timeout covers the wait for response headers.
 */
export async function sendPinnedRequest(
  url: string,
  pinned: PinnedAddress,
  {
    method = 'GET',
    headers,
    timeoutMs,
    signal
  }: {
    method?: PublicFetchMethod;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<PinnedResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout =
    timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers,
      agent: createPinnedAgent(url, pinned),
      // node-fetch v2 uses its own AbortSignal type definition.
      signal: controller.signal as unknown as NodeFetchAbortSignal
    });
    return {
      response,
      cancel: () => {
        // node-fetch v2 pipes through a PassThrough: destroy alone need not
        // abort the owning request. Keep its AbortController until disposal.
        signal?.removeEventListener('abort', abort);
        controller.abort();
        destroyBody(response);
      }
    };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function destroyBody(response: Response): void {
  const body = response.body as unknown;
  if (body && typeof (body as Readable).destroy === 'function') {
    (body as Readable).destroy();
  }
}

function withoutCredentialHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase())
    )
  );
}

/**
 * Validates, sends and follows redirects until a non-redirect response is
 * received. The caller owns the returned response and must call `cancel`.
 */
export async function openPublicResponse(
  url: string,
  options: OpenPublicResponseOptions
): Promise<OpenedPublicResponse> {
  const { signal, maxRedirects } = options;
  let headers = options.headers;
  const resolveTarget =
    options.resolveTarget ??
    ((target: string, targetSignal?: AbortSignal) =>
      publicNetwork.resolveTarget(target, {
        signal: targetSignal,
        httpsOnly: options.httpsOnly
      }));
  const sendRequest =
    options.sendRequest ??
    ((target: string, pinned: PinnedAddress, targetSignal?: AbortSignal) =>
      sendPinnedRequest(target, pinned, {
        method: options.method,
        headers,
        timeoutMs: options.requestTimeoutMs,
        signal: targetSignal
      }));

  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal?.throwIfAborted();
    const pinned = await resolveTarget(currentUrl, signal);
    signal?.throwIfAborted();
    const sent = await sendRequest(currentUrl, pinned, signal);
    const location = isRedirectStatus(sent.response.status)
      ? sent.response.headers.get('location')
      : null;
    if (!location) {
      return { ...sent, finalUrl: currentUrl };
    }
    try {
      const next = new URL(location, currentUrl);
      if (next.origin !== new URL(currentUrl).origin) {
        headers = withoutCredentialHeaders(headers);
      }
      currentUrl = next.toString();
    } finally {
      sent.cancel();
    }
  }
  throw new Error(`Too many redirects while fetching ${url}`);
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), {
    name: 'AbortError'
  });
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function checkDeclaredLength(response: Response, maxBytes: number): void {
  const contentLength = response.headers.get('content-length');
  if (!contentLength) return;
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PublicResponseTooLargeError(maxBytes, declared, 'content-length');
  }
}

/**
 * Reads a response body up to `maxBytes`, rejecting as soon as the declared
 * or streamed size exceeds it. The stream is destroyed on overflow or abort.
 */
export async function readPublicResponseBody(
  response: Response,
  { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal }
): Promise<Buffer> {
  checkDeclaredLength(response, maxBytes);
  const body = response.body as unknown;
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) {
      throw new PublicResponseTooLargeError(maxBytes, body.length, 'stream');
    }
    return body;
  }
  const stream = body as Readable;
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value!);
    };
    // Prefer the transport's own abort error, which it emits on the stream.
    const onAbort = () => {
      stream.destroy(abortError());
    };
    if (signal?.aborted) {
      stream.destroy();
      finish(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: unknown) => {
      const buffer = toBuffer(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        finish(new PublicResponseTooLargeError(maxBytes, total, 'stream'));
        stream.destroy();
        return;
      }
      chunks.push(buffer);
    });
    stream.once('end', () => finish(null, Buffer.concat(chunks, total)));
    stream.once('error', (error) => finish(error));
    stream.once('close', () => finish(abortError()));
  });
}

/**
 * One-shot public request: follows validated redirects and reads the body
 * of a 2xx GET response up to `maxBytes`.
 */
export async function publicFetch(
  url: string,
  options: PublicFetchOptions
): Promise<PublicFetchResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs);
  let opened: OpenedPublicResponse | undefined;
  try {
    opened = await openPublicResponse(url, {
      ...options,
      signal: controller.signal
    });
    const { response } = opened;
    const body =
      response.ok && options.method !== 'HEAD'
        ? await readPublicResponseBody(response, {
            maxBytes: options.maxBytes,
            signal: controller.signal
          })
        : Buffer.alloc(0);
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body,
      finalUrl: opened.finalUrl
    };
  } catch (error) {
    if (timedOut) throw new PublicFetchTimeoutError(options.timeoutMs!);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    opened?.cancel();
  }
}
