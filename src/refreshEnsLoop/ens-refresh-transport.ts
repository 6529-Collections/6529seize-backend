import type { FetchRequest } from 'ethers';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';

type TransportResponse = Awaited<ReturnType<FetchRequest['getUrlFunc']>>;

function readResponse(
  url: string,
  input: FetchRequest,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const request = send(
      url,
      { method: input.method, headers, signal },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
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
                  ? gunzipSync(body)
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
  signal: AbortSignal
): Promise<TransportResponse> {
  let url = input.url;
  const headers = { ...input.headers };
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await readResponse(url, input, headers, signal);
    const location = response.headers.location;
    if (![301, 302].includes(response.statusCode) || !location) return response;
    // Keep ethers' HTTP-only redirect and HTTPS downgrade protections.
    if (
      !/^https?:/.test(location) ||
      (url.startsWith('https:') && !location.startsWith('https:'))
    ) {
      throw new Error('Unsupported ENS HTTP redirect');
    }
    if (new URL(location).host !== new URL(url).host) {
      delete headers.authorization;
      delete headers.cookie;
    }
    url = location;
  }
  throw new Error('Too many ENS HTTP redirects');
}

/** Unlike the installed ethers adapter, abort the actual Node HTTP request. */
export const abortableEnsGetUrl: FetchRequest['getUrlFunc'] = async (
  request,
  signal
) => {
  const abort = new AbortController();
  signal?.addListener(() => abort.abort());
  const timer = setTimeout(() => abort.abort(), request.timeout);
  try {
    return await followRedirects(request, abort.signal);
  } finally {
    clearTimeout(timer);
  }
};
