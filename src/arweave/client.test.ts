import { createArweaveClient } from './client';

afterEach(() => jest.restoreAllMocks());
it('fails over SDK balance, price and anchor reads, including invalid successful responses', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'ardrive.net')
        return new Response('<html>unavailable</html>');
      return new Response(
        url.pathname === '/tx_anchor' ? 'a'.repeat(43) : '100'
      );
    });
  const client = createArweaveClient();
  await expect(client.wallets.getBalance('a'.repeat(43))).resolves.toBe('100');
  await expect(client.transactions.getPrice(10)).resolves.toBe('100');
  await expect(client.transactions.getTransactionAnchor()).resolves.toBe(
    'a'.repeat(43)
  );
  expect(
    fetch.mock.calls.map(([input]) => new URL(String(input)).hostname)
  ).toEqual([
    'ardrive.net',
    'arweave.net',
    'ardrive.net',
    'arweave.net',
    'ardrive.net',
    'arweave.net'
  ]);
});

it('checks alternative nodes before returning transaction absence', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response('', { status: 404 }));
  await expect(
    createArweaveClient().transactions.getStatus('a'.repeat(43))
  ).resolves.toEqual({ status: 404, confirmed: null });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['get', 'request'] as const)(
  'rejects SDK %s webstream before starting a request',
  async (method) => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(
      createArweaveClient().api[method]('info', { responseType: 'webstream' })
    ).rejects.toThrow('buffered response');
    expect(fetch).not.toHaveBeenCalled();
  }
);

it.each([
  '<html>unavailable</html>',
  'null',
  '{}',
  '{"block_height":-1}',
  '{"block_height":"1"}'
])('recovers malformed transaction confirmation %s', async (body) => {
  const confirmed = {
    block_height: 1,
    block_indep_hash: 'b'.repeat(64),
    number_of_confirmations: 2
  };
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(new Response(JSON.stringify(confirmed)));
  await expect(
    createArweaveClient().transactions.getStatus('a'.repeat(43))
  ).resolves.toEqual({ status: 200, confirmed });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('preserves pending transaction status', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('', { status: 202 }));
  await expect(
    createArweaveClient().transactions.getStatus('a'.repeat(43))
  ).resolves.toEqual({ status: 202, confirmed: null });
  expect(fetch).toHaveBeenCalledTimes(1);
});
