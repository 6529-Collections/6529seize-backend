import { createArweaveClient } from './client';

afterEach(() => jest.restoreAllMocks());

it.each([undefined, 'text', 'arraybuffer'] as const)(
  'validates query-bearing status requests in %s mode',
  async (responseType) => {
    const confirmed = {
      block_height: 1,
      block_indep_hash: 'block',
      number_of_confirmations: 2
    };
    const text = JSON.stringify(confirmed);
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response(text));
    const response = await createArweaveClient().api.get(
      `/tx/${'a'.repeat(43)}/status?probe=1#ignored`,
      { responseType }
    );
    const body =
      responseType === 'arraybuffer'
        ? new TextDecoder().decode(response.data as ArrayBuffer)
        : response.data;
    expect(body).toEqual(responseType ? text : confirmed);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        ([input]) => new URL(String(input)).search === '?probe=1'
      )
    ).toBe(true);
  }
);

it('preserves final absence for query-bearing status requests', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response('', { status: 404 }));
  await expect(
    createArweaveClient().api.get(`/tx/${'a'.repeat(43)}/status?probe=1`)
  ).resolves.toMatchObject({ status: 404 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['tx_anchor', 'price/10', `wallet/${'a'.repeat(43)}/balance`])(
  'validates query-bearing %s reads',
  async (path) => {
    const body = path === 'tx_anchor' ? 'a'.repeat(43) : '100';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response(body));
    await expect(
      createArweaveClient().api.get(`/${path}?probe=1`)
    ).resolves.toMatchObject({ data: body });
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);
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

it.each(['tx_anchor', 'price/10', `wallet/${'a'.repeat(43)}/balance`])(
  'validates the leading-slash SDK endpoint /%s',
  async (path) => {
    const good = path === 'tx_anchor' ? 'a'.repeat(43) : '100';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response(good));
    await expect(
      createArweaveClient().api.get(`/${path}`)
    ).resolves.toMatchObject({ data: good });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        ([input]) => new URL(String(input)).pathname === `/${path}`
      )
    ).toBe(true);
  }
);

it('validates leading-slash status data and preserves final 404 semantics', async () => {
  const path = `/tx/${'a'.repeat(43)}/status`;
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(new Response('<html>error</html>'))
    .mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(createArweaveClient().api.get(path)).resolves.toMatchObject({
    status: 404
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ['tx_anchor', JSON.stringify(['a'.repeat(43)]), 'a'.repeat(43)],
  ['price/10', '[100]', '100'],
  [`wallet/${'a'.repeat(43)}/balance`, '[100]', '100'],
  ['price/10', '{"value":100}', '100']
])(
  'rejects a non-scalar SDK body for %s before string coercion',
  async (path, body, good) => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response(good));
    await expect(createArweaveClient().api.get(path)).resolves.toMatchObject({
      data: good
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);

it('honors a caller retry veto for provider failures', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('', { status: 503 }));
  const shouldRetry = jest.fn(() => false);
  await expect(
    createArweaveClient({ shouldRetry }).wallets.getBalance('a'.repeat(43))
  ).rejects.toThrow('HTTP 503');
  expect(shouldRetry).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps HTTP 400 terminal when the caller permits retries', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('', { status: 400 }));
  await expect(
    createArweaveClient({ shouldRetry: () => true }).wallets.getBalance(
      'a'.repeat(43)
    )
  ).rejects.toThrow('HTTP 400');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['get', 'request'] as const)(
  'validates text-mode SDK %s confirmations without changing returned bytes',
  async (method) => {
    const text =
      '{ "block_height": 1, "block_indep_hash": "block", "number_of_confirmations": 2 }';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response(text));
    const response = await createArweaveClient().api[method](
      `/tx/${'a'.repeat(43)}/status`,
      { responseType: 'text' }
    );
    expect(response.data).toBe(text);
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);

it.each([201, 204, 208])(
  'retries unexpected HTTP %s status responses before accepting a confirmation',
  async (status) => {
    const confirmed = {
      block_height: 1,
      block_indep_hash: 'block',
      number_of_confirmations: 2
    };
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify(confirmed)));
    await expect(
      createArweaveClient().transactions.getStatus('a'.repeat(43))
    ).resolves.toEqual({ status: 200, confirmed });
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);

it.each([
  ['tx_anchor', 'a'.repeat(43)],
  ['price/10', '100'],
  [`wallet/${'a'.repeat(43)}/balance`, '100'],
  [
    `tx/${'a'.repeat(43)}/status`,
    '{"block_height":1,"block_indep_hash":"block","number_of_confirmations":2}'
  ]
])(
  'validates arraybuffer SDK responses for %s while preserving their representation',
  async (path, body) => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response(body));
    const response = await createArweaveClient().api.get(path, {
      responseType: 'arraybuffer'
    });
    expect(response.data).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(response.data as ArrayBuffer)).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);
