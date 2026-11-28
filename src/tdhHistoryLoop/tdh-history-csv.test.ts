import fetch, { Response } from 'node-fetch';
import { json2csv } from 'json-2-csv';
import { getArweaveFallbackUrls } from '@/arweave-gateway-fallback';
import { fetchConsolidatedTdhCsv } from './tdh-history-csv';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn()
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
  }
}));

const url = `https://arweave.net/${'A'.repeat(43)}`;
const block = 123;
const snapshot = {
  block,
  date: '20261126',
  consolidation_key: 'wallet-1',
  wallets: '["wallet-1"]',
  total_balance: 4,
  tdh: 123,
  memes: '[]',
  gradients: '[]',
  nextgen: '[]',
  boost_breakdown: '{}'
};
const validCsv = json2csv([snapshot]);

beforeEach(() => jest.mocked(fetch).mockReset());

it.each([
  ['HTML', '<html>temporary gateway error</html>'],
  ['empty body', ''],
  ['headers only', validCsv.split('\n')[0]],
  ['unrelated CSV', 'name,value\nerror,unavailable'],
  ['missing required fields', 'block,date\n123,20261126'],
  ['unequal columns', `${validCsv}\n123,20261126`],
  ['wrong block', json2csv([{ ...snapshot, block: 999 }])],
  ['invalid date', json2csv([{ ...snapshot, date: '20260230' }])],
  ['invalid totals', json2csv([{ ...snapshot, tdh: 'not-a-number' }])],
  ['invalid wallet JSON', json2csv([{ ...snapshot, wallets: 'not-json' }])],
  ['wrong wallet shape', json2csv([{ ...snapshot, wallets: '{}' }])],
  ['non-string wallet', json2csv([{ ...snapshot, wallets: '[1]' }])],
  ['invalid token JSON', json2csv([{ ...snapshot, memes: 'not-json' }])],
  ['wrong token shape', json2csv([{ ...snapshot, gradients: 'null' }])],
  ['invalid boost JSON', json2csv([{ ...snapshot, boost_breakdown: '{' }])]
])('tries another gateway when HTTP 200 contains %s', async (_kind, body) => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(new Response(validCsv));

  const rows = await fetchConsolidatedTdhCsv(url, block);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    block,
    date: new Date('2026-11-26'),
    consolidation_key: 'wallet-1',
    wallets: ['wallet-1'],
    balance: 4,
    tdh: 123,
    memes: [],
    gradients: [],
    nextgen: [],
    boost_breakdown: {}
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const hosts = jest
    .mocked(fetch)
    .mock.calls.map(([candidate]) => new URL(String(candidate)).host);
  expect(new Set(hosts).size).toBe(2);
});

it('rejects instead of returning an empty snapshot when every gateway serves malformed data', async () => {
  jest
    .mocked(fetch)
    .mockImplementation(async () => new Response('<html>error</html>'));

  await expect(fetchConsolidatedTdhCsv(url, block)).rejects.toThrow(
    'no snapshot rows'
  );

  expect(fetch).toHaveBeenCalledTimes(
    new Set([url, ...getArweaveFallbackUrls(url)]).size
  );
});

it('keeps zero totals and omitted historical optional fields valid', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(
    new Response(
      json2csv([
        {
          block,
          date: '20261126',
          consolidation_key: 'wallet-1',
          wallets: '["wallet-1"]',
          total_balance: 0,
          tdh: 0
        }
      ])
    )
  );
  await expect(fetchConsolidatedTdhCsv(url, block)).resolves.toEqual([
    expect.objectContaining({
      balance: 0,
      tdh: 0,
      memes: [],
      gradients: [],
      nextgen: []
    })
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects a whole response when a later row is malformed, then accepts the complete alternate snapshot', async () => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(
      new Response(json2csv([snapshot, { ...snapshot, wallets: 'not-json' }]))
    )
    .mockResolvedValueOnce(new Response(validCsv));
  await expect(fetchConsolidatedTdhCsv(url, block)).resolves.toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('still advances after HTTP errors', async () => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(new Response('missing', { status: 404 }))
    .mockResolvedValueOnce(new Response(validCsv));
  await expect(fetchConsolidatedTdhCsv(url, block)).resolves.toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});
