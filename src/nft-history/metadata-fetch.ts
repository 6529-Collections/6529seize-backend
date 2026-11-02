import { parseDecentralizedMediaRef } from '@/decentralized-media/decentralized-media';

export const MAX_HISTORY_METADATA_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

function verifiedGateway(input: string): URL {
  const url = new URL(input);
  // Reuse the central gateway catalog. Arbitrary protocol-1 HTTPS origins need
  // an explicit policy review before history ingestion can fetch them.
  const recognized = parseDecentralizedMediaRef(url.href);
  // Arweave also redirects to base32 transaction sandbox subdomains.
  const sandbox = /^[a-z2-7]{52}\.arweave\.net$/.test(url.hostname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (!recognized && !sandbox)
  )
    throw new Error('Unsupported metadata gateway');
  return url;
}

async function boundedText(response: Response): Promise<string> {
  if (
    Number(response.headers.get('content-length')) > MAX_HISTORY_METADATA_BYTES
  ) {
    await response.body?.cancel();
    throw new Error('History metadata exceeds byte limit');
  }
  if (!response.body) throw new Error('Empty history metadata body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString('utf8');
      bytes += value.byteLength;
      if (bytes > MAX_HISTORY_METADATA_BYTES)
        throw new Error('History metadata exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function fetchGatewayMetadata(
  input: string,
  signal: AbortSignal
): Promise<string> {
  let url = verifiedGateway(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const response = await fetch(url.href, { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === MAX_REDIRECTS)
        throw new Error('Invalid metadata redirect chain');
      url = verifiedGateway(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Metadata fetch failed (${response.status})`);
    }
    return boundedText(response);
  }
  throw new Error('Invalid metadata redirect chain');
}
