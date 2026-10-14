import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ApiCompliantException } from '@/exceptions';
import * as db from '@/api/oracle/api.oracle.db';
import router from '@/api/oracle/api.oracle.routes';

jest.mock('yamljs', () => ({ load: jest.fn() }));
jest.mock('swagger-ui-express', () => ({
  serveFiles: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  setup: () => (_req: Request, _res: Response, next: NextFunction) => next()
}));
jest.mock('@/api/oracle/api.oracle.db');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/oracle', router);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiCompliantException) {
      res.status(error.getStatusCode()).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  });
  server = await new Promise<Server>((accept) => {
    const listeningServer = app.listen(0, '127.0.0.1', () =>
      accept(listeningServer)
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
  });
});

beforeEach(() => jest.resetAllMocks());

describe('retired Prenode registry', () => {
  it.each([
    { method: 'POST', path: '/register-prenode', body: {} },
    {
      method: 'POST',
      path: '/register-prenode',
      body: { domain: 'node.example', tdh: 42, block: 123 }
    },
    { method: 'GET', path: '/prenodes?page=1&page_size=20' },
    { method: 'GET', path: '/prenodes?page=invalid' }
  ])(
    'returns a non-cacheable 410 for $method $path without data access',
    async ({ method, path, body }) => {
      const response = await fetch(`${baseUrl}/oracle${path}`, {
        method,
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            }
          : {})
      });
      expect(response.status).toBe(410);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error:
          '6529 Prenodes have been deprecated. Use the 6529 Desktop app to calculate TDH.'
      });
      for (const mock of Object.values(db).filter(
        (value) => typeof value === 'function'
      )) {
        expect(mock).not.toHaveBeenCalled();
      }
    }
  );
});

const totals = {
  tdh: 100,
  memes_tdh: 60,
  gradients_tdh: 30,
  nextgen_tdh: 10,
  block: 123,
  merkle_root: 'root'
};
const seasons = {
  seasons: [{ season: 1, tdh: 60 }],
  block: 123,
  merkle_root: 'root'
};
const nft = { id: 1, contract: 'memes', tdh: 60 };
const nfts = { nfts: [nft], block: 123, merkle_root: 'root' };

describe('preserved Oracle TDH reads', () => {
  it.each([
    {
      path: '/tdh/total',
      query: db.fetchTotalTDH,
      args: [],
      result: totals,
      response: totals
    },
    {
      path: '/tdh/above/50',
      query: db.fetchTDHAbove,
      args: [50, false],
      result: totals,
      response: totals
    },
    {
      path: '/tdh/above/50/entries',
      query: db.fetchTDHAbove,
      args: [50, true],
      result: totals,
      response: totals
    },
    {
      path: '/tdh/percentile/100',
      query: db.fetchTDHPercentile,
      args: [1],
      result: totals,
      response: totals
    },
    {
      path: '/tdh/cutoff/10',
      query: db.fetchTDHCutoff,
      args: [10],
      result: totals,
      response: totals
    },
    {
      path: '/address/0xabc',
      query: db.fetchSingleAddressTDH,
      args: ['0xabc'],
      result: totals,
      response: totals
    },
    {
      path: '/address/0xabc/breakdown',
      query: db.fetchSingleAddressTDHBreakdown,
      args: ['0xabc'],
      result: totals,
      response: totals
    },
    {
      path: '/address/0xabc/memes_seasons',
      query: db.fetchSingleAddressTDHMemesSeasons,
      args: ['0xabc'],
      result: seasons,
      response: seasons
    },
    {
      path: '/address/0xabc/memes_seasons/1',
      query: db.fetchSingleAddressTDHMemesSeasons,
      args: ['0xabc'],
      result: seasons,
      response: { season: 1, tdh: 60, block: 123 }
    },
    {
      path: '/address/0xabc/memes/1',
      query: db.fetchSingleAddressTDHForNft,
      args: ['0xabc', 'memes', 1],
      result: totals,
      response: totals
    },
    {
      path: '/nfts/memes_seasons',
      query: db.fetchSeasonsTDH,
      args: [undefined],
      result: seasons,
      response: seasons
    },
    {
      path: '/nfts/memes_seasons/1',
      query: db.fetchSeasonsTDH,
      args: ['1'],
      result: seasons,
      response: { season: 1, tdh: 60, block: 123 }
    },
    {
      path: '/nfts',
      query: db.fetchNfts,
      args: [undefined, undefined],
      result: nfts,
      response: nfts
    },
    {
      path: '/nfts/memes',
      query: db.fetchNfts,
      args: ['memes', undefined],
      result: nfts,
      response: nfts
    },
    {
      path: '/nfts/memes/1',
      query: db.fetchNfts,
      args: ['memes', 1],
      result: nfts,
      response: { ...nft, block: 123 }
    }
  ])(
    'keeps GET /oracle$path and its response',
    async ({ path, query, args, result, response: expected }) => {
      jest.mocked(query).mockResolvedValueOnce(result as never);
      const response = await fetch(`${baseUrl}/oracle${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(query).toHaveBeenCalledWith(...args);
    }
  );

  it.each([
    '/tdh/percentile/0',
    '/tdh/percentile/10001',
    '/tdh/cutoff/0',
    '/address/0xabc/memes/invalid',
    '/nfts/memes_seasons/invalid'
  ])('preserves validation on %s', async (path) => {
    jest.mocked(db.fetchSeasonsTDH).mockResolvedValueOnce(seasons);
    const response = await fetch(`${baseUrl}/oracle${path}`);
    expect(response.status).toBe(400);
  });

  it('preserves the complete public TDH contract without registration exposure', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../../openapi.oracle.yaml'), 'utf8')
    );
    expect(spec.info.title).toBe('6529 Oracle TDH API');
    expect(Object.keys(spec.paths).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        '/tdh/total',
        '/tdh/above/{value}',
        '/tdh/above/{value}/entries',
        '/tdh/percentile/{value}',
        '/tdh/cutoff/{value}',
        '/address/{address}',
        '/address/{address}/breakdown',
        '/address/{address}/{contract}/{id}',
        '/address/{address}/memes_seasons',
        '/address/{address}/memes_seasons/{id}',
        '/nfts',
        '/nfts/{contract}',
        '/nfts/{contract}/{id}',
        '/nfts/memes_seasons',
        '/nfts/memes_seasons/{id}'
      ].sort((a, b) => a.localeCompare(b))
    );
    const mainSpec = parse(
      readFileSync(resolve(__dirname, '../../openapi.yaml'), 'utf8')
    );
    expect(
      Object.keys(mainSpec.paths).some((path) =>
        /prenode|register-prenode/.test(path)
      )
    ).toBe(false);
  });
});
