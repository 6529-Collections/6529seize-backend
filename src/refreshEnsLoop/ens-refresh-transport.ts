import type { FetchRequest } from 'ethers';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';
import {
  assertPublicEnsUrl,
  publicEnsLookup
} from '@/refreshEnsLoop/ens-refresh-public-network';

type TransportResponse = Awaited<ReturnType<FetchRequest['getUrlFunc']>>;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function readResponse(
  url: string,
  input: FetchRequest,
  headers: Record<string, string>,
  signal: AbortSignal,
  publicOnly: boolean
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: input.method,
        headers,
        signal,
        lookup: publicOnly ? publicEnsLookup : undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES)
            request.destroy(new Error('ENS response too large'));
          else chunks.push(chunk);
        });
        response.once('aborted', () =>
          reject(new Error('ENS HTTP response aborted'))
        );
        response.once('error', reject);
        response.once('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            responseHeaders[name] = Array.isArray(value)
              ? value.join(', ')
              : (value ?? '');
          }
          try {
            const body = Buffer.concat(chunks);
            resolve({
              statusCode: response.statusCode ?? 0,
              statusMessage: response.statusMessage ?? '',
              headers: responseHeaders,
              body:
                responseHeaders['content-encoding'] === 'gzip'
                  ? gunzipSync(body, { maxOutputLength: MAX_RESPONSE_BYTES })
                  : body
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once('error', reject);
    if (input.body) request.write(Buffer.from(input.body));
    request.end();
  });
}

async function followRedirects(
  input: FetchRequest,
  signal: AbortSignal,
  publicOnly: boolean
): Promise<TransportResponse> {
  let url = input.url;
  const headers = { ...input.headers };
  for (let attempt = 0; attempt < 10; attempt++) {
    if (publicOnly) assertPublicEnsUrl(url);
    const response = await readResponse(
      url,
      input,
      headers,
      signal,
      publicOnly
    );
    const location = response.headers.location;
    if (![301, 302].includes(response.statusCode) || !location) return response;
    const target = new URL(location, url);
    // Keep HTTP-only redirects and HTTPS downgrade protections.
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      (new URL(url).protocol === 'https:' && target.protocol !== 'https:')
    ) {
      throw new Error('Unsupported ENS HTTP redirect');
    }
    if (target.origin !== new URL(url).origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    url = target.href;
  }
  throw new Error('Too many ENS HTTP redirects');
}

/** Unlike the installed ethers adapter, abort the actual Node HTTP request. */
function createTransport(publicOnly: boolean): FetchRequest['getUrlFunc'] {
  return async (request, signal) => {
    const abort = new AbortController();
    signal?.addListener(() => abort.abort());
    const timer = setTimeout(() => abort.abort(), request.timeout);
    try {
      return await followRedirects(request, abort.signal, publicOnly);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const abortableEnsGetUrl = createTransport(false);
export const publicEnsGetUrl = createTransport(true);
