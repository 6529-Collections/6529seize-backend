import { fetchHistoryMetadata } from './metadata';
import {
  fetchGatewayMetadata,
  MAX_HISTORY_METADATA_BYTES
} from './metadata-fetch';

const id = 'IFosq_ZN9_PrDSQmq65JTjeB2GnnfPSFoHxRazxC4PY';
const url = `https://arweave.net/${id}`;
const download = (input = url) =>
  fetchGatewayMetadata(input, AbortSignal.timeout(1000));
afterEach(() => jest.restoreAllMocks());

it.each([
  'https://169.254.169.254/latest/meta-data/',
  'https://localhost/metadata',
  'https://10.0.0.5/metadata',
  'https://attacker.example/metadata',
  `https://arweave.net.attacker.example/${id}`,
  `http://arweave.net/${id}`,
  `https://user:secret@arweave.net/${id}`,
  `https://arweave.net:8443/${id}`
])('rejects unapproved gateway %s before fetching', async (input) => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  await expect(download(input)).rejects.toThrow('Unsupported metadata gateway');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('checks redirects before fetching their destination', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/secret' }
    })
  );
  await expect(download()).rejects.toThrow('Unsupported metadata gateway');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ redirect: 'manual' })
  );
});

it('accepts a gateway redirect to an Arweave sandbox', async () => {
  const destination = `https://${'a'.repeat(52)}.arweave.net/${id}`;
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: destination } })
    )
    .mockResolvedValueOnce(new Response('{"name":"Mint"}'));
  await expect(download()).resolves.toBe('{"name":"Mint"}');
  expect(fetchMock.mock.calls[1][0]).toBe(destination);
});

it('caps redirect loops', async () => {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: url } })
    );
  await expect(download()).rejects.toThrow('Invalid metadata redirect chain');
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('rejects oversized declared bodies before reading them', async () => {
  const response = new Response('small', {
    headers: { 'content-length': String(MAX_HISTORY_METADATA_BYTES + 1) }
  });
  const read = jest.spyOn(response.body!, 'getReader');
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  await expect(download()).rejects.toThrow('exceeds byte limit');
  expect(read).not.toHaveBeenCalled();
});

it('bounds decoded streamed bytes even without content-length', async () => {
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(500_001));
    },
    cancel
  });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
  await expect(download()).rejects.toThrow('exceeds byte limit');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('shares one deadline across Arweave fallback attempts', async () => {
  const signals: unknown[] = [];
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_, options) => {
      signals.push(options?.signal);
      if (signals.length === 1) return new Response(null, { status: 503 });
      return new Response('{"name":"fallback"}');
    });
  await expect(fetchHistoryMetadata(url)).resolves.toEqual({
    name: 'fallback'
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(signals[0]).toBe(signals[1]);
});

it('keeps IPFS metadata on approved gateways', async () => {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"name":"ipfs"}'));
  await expect(
    fetchHistoryMetadata(
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json'
    )
  ).resolves.toEqual({ name: 'ipfs' });
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/metadata.json'
  );
});
