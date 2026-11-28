import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { RateLimitedFetcher } from './rate-limited-fetcher';
import { formatTokenDayFile, formatWalletDayFile } from './tdh-day-file';
import {
  decodeTdhDay,
  decodeTokenRows,
  decodeWalletRows,
  FileTdhChainSource,
  GatewayTdhChainSource,
  readChainDay,
  TdhChainSourceError,
  TdhGatewayRouteError,
  tokenDayFileName,
  walletDayFileName
} from './tdh-chain-source';
import { TdhChainDay } from './tdh-chain.types';

const H = 1200;

function readStamp(height: number) {
  return {
    at: 'finalized',
    height,
    root: `0x${'ee'.repeat(32)}`,
    slot: height + 10,
    time: 1_791_000_000_000,
    finalizedHeight: height,
    headHeight: height + 3,
    network: `0x${'0d'.repeat(32)}`
  };
}

/** A day's record as the gateway's TDH routes give it. */
function dayData(day: TdhChainDay) {
  const h = day.header;
  return {
    day: h.cycleDay,
    boundary: h.boundary,
    tdhRuleId: h.tdhRuleId,
    cutoff: {
      number: h.cutoffNumber,
      hash: h.cutoffHash.toUpperCase().replace('0X', '0x'),
      timestamp: h.cutoffTimestamp
    },
    walletRoot: h.walletRoot,
    walletCount: h.walletCount,
    identityCount: h.identityCount,
    totalTdh: String(h.totalTdh),
    tokenRoot: h.tokenRoot,
    tokenCount: h.tokenCount,
    changesRoot: `0x${'00'.repeat(32)}`,
    changesCount: 0,
    listsHeld: true
  };
}

const walletRow = (l: TdhChainDay['walletLeaves'][number]) => ({
  wallet: l.wallet,
  cid: l.cid,
  identityTdh: String(l.identityTdh),
  walletTdh: String(l.walletTdh),
  walletCount: l.walletCount
});

const tokenRow = (t: NonNullable<TdhChainDay['tokenLeaves']>[number]) => ({
  cid: t.cid,
  contract: t.contract,
  tokenId: t.tokenId,
  tokenTdh: String(t.tokenTdh)
});

/**
 * A gateway holding one day, at finalized height `height` (a list read
 * pinned at a height in `gone` answers 409 `height_gone`).
 */
function fakeGateway(
  day: TdhChainDay,
  opts: {
    tokens?: boolean;
    gone?: number[];
    walletRows?: ReturnType<typeof walletRow>[];
    tokenRows?: unknown[];
    chunk?: (data: any) => any;
    /** Answers 404 for a list chunk this picks (a node without the list). */
    drop?: (url: URL) => boolean;
    /** Serves at most this many rows a chunk, whatever the limit asks. */
    pageRows?: number;
  } = {}
) {
  let height = H;
  const requests: string[] = [];
  const json = (status: number, body: unknown) =>
    Response.json(body, { status });
  // As the gateway answers: a route it doesn't know, or a day it doesn't hold.
  const notFound = (message: string) =>
    json(404, {
      read: readStamp(height),
      error: { code: 'not_found', message }
    });
  const list = (url: URL, rows: any[], extra: Record<string, unknown>) => {
    const pin = Number(url.searchParams.get('height'));
    if (opts.drop?.(url)) return notFound('no list for that day');
    if ((opts.gone ?? []).includes(pin)) {
      return json(409, {
        read: readStamp(height),
        error: {
          code: 'height_gone',
          message: `holds ${height - 64}..${height}`
        }
      });
    }
    const limit = Math.min(
      Number(url.searchParams.get('limit')),
      opts.pageRows ?? Infinity
    );
    const after = url.searchParams.get('after');
    const key = (r: any) => r.wallet ?? `${r.cid}:${r.contract}:${r.tokenId}`;
    const from =
      after === null ? 0 : rows.findIndex((r) => key(r) === after) + 1;
    const page = rows.slice(from, from + limit);
    const more = from + limit < rows.length;
    const data = { day: day.header.cycleDay, ...extra, rows: page };
    return json(200, {
      read: readStamp(pin),
      data: opts.chunk ? opts.chunk(data) : data,
      next: more ? key(page[page.length - 1]) : null
    });
  };
  const fetchFn = async (raw: string) => {
    requests.push(raw);
    const url = new URL(raw);
    const p = url.pathname;
    const n = day.header.cycleDay;
    if (p === '/v1/tdh' || p === `/v1/tdh/days/${n}`) {
      return json(200, {
        read: readStamp(height),
        data: dayData(day),
        next: null
      });
    }
    if (p === `/v1/tdh/days/${n}/wallets`) {
      return list(url, opts.walletRows ?? day.walletLeaves.map(walletRow), {
        walletRoot: day.header.walletRoot,
        walletCount: day.header.walletCount,
        identityCount: day.header.identityCount
      });
    }
    if (p === `/v1/tdh/days/${n}/tokens` && opts.tokens !== false) {
      return list(url, opts.tokenRows ?? day.tokenLeaves!.map(tokenRow), {
        tokenRoot: day.header.tokenRoot,
        tokenCount: day.header.tokenCount
      });
    }
    return /^\/v1\/tdh\/days\/\d+$/.test(p)
      ? notFound('no such day')
      : notFound('no such route');
  };
  const fetcher = new RateLimitedFetcher({
    allowedHosts: ['gateway.example'],
    minIntervalMs: 0,
    retries: 0,
    fetchFn
  });
  return {
    fetcher,
    requests,
    advance: (to: number) => {
      height = to;
    }
  };
}

const BASE = 'https://gateway.example';
const pathOf = (u: string) => {
  const url = new URL(u);
  return `${url.pathname}${url.search}`;
};

describe('gateway decoders', () => {
  it('decodes a day record and its read stamp, lowercasing hashes', () => {
    const day = chainDayFixture();
    expect(decodeTdhDay(dayData(day), readStamp(H))).toEqual({
      header: day.header,
      apply: {
        applyHeight: null,
        applyBlockHash: null,
        applyTimeMs: null,
        finalizedHeight: H
      }
    });
    expect(decodeTdhDay(dayData(day)).apply.finalizedHeight).toBeNull();
  });

  it('refuses a record with a bad value', () => {
    const day = chainDayFixture();
    const bad = (over: Record<string, unknown>) => () =>
      decodeTdhDay({ ...dayData(day), ...over });
    expect(bad({ totalTdh: '-1' })).toThrow();
    expect(bad({ totalTdh: '9007199254740993' })).toThrow();
    expect(bad({ walletRoot: '0x12' })).toThrow();
    expect(
      bad({ cutoff: { number: 1, hash: '0x00', timestamp: 1 } })
    ).toThrow();
  });

  it('decodes wallet and token rows and refuses bad ones', () => {
    const day = chainDayFixture();
    expect(decodeWalletRows(day.walletLeaves.map(walletRow))).toEqual(
      day.walletLeaves
    );
    expect(decodeTokenRows(day.tokenLeaves!.map(tokenRow))).toEqual(
      day.tokenLeaves
    );
    const w = walletRow(day.walletLeaves[0]);
    expect(() => decodeWalletRows([{ ...w, wallet: '0x12' }])).toThrow();
    expect(() => decodeWalletRows([{ ...w, walletTdh: 1.5 }])).toThrow();
    expect(() => decodeWalletRows({ rows: [] })).toThrow();
    const t = tokenRow(day.tokenLeaves![0]);
    // The gateway sends ids past 128 bits in hex.
    expect(
      decodeTokenRows([
        { ...t, tokenId: '0x400000000000000000000000000000005' }
      ])[0].tokenId
    ).toBe('1361129467683753853853498429727072845829');
    expect(() => decodeTokenRows([{ ...t, tokenId: '1.5' }])).toThrow();
    expect(() =>
      decodeTokenRows([{ ...t, tokenId: `0x${'f'.repeat(65)}` }])
    ).toThrow();
    expect(() =>
      decodeTokenRows([
        { ...t, tokenId: (BigInt(1) << BigInt(256)).toString() }
      ])
    ).toThrow();
  });
});

describe('GatewayTdhChainSource', () => {
  it('reads a day in chunks, every chunk pinned at the height its record was read at', async () => {
    const day = chainDayFixture();
    const gw = fakeGateway(day);
    const source = new GatewayTdhChainSource(`${BASE}/`, gw.fetcher, 2);
    expect((await source.latestDay())!.header).toEqual(day.header);
    const read = await readChainDay(source, day.header.cycleDay);
    expect(read).toEqual({
      ...day,
      apply: {
        applyHeight: null,
        applyBlockHash: null,
        applyTimeMs: null,
        finalizedHeight: H
      }
    });
    const lists = gw.requests.map(pathOf).filter((p) => p.includes('/wallets'));
    const w = day.walletLeaves.map((l) => l.wallet);
    expect(lists).toEqual([
      `/v1/tdh/days/20737/wallets?limit=2&height=${H}`,
      `/v1/tdh/days/20737/wallets?after=${w[1]}&limit=2&height=${H}`,
      `/v1/tdh/days/20737/wallets?after=${w[3]}&limit=2&height=${H}`
    ]);
    expect(gw.requests.map(pathOf)).toContain('/v1/tdh');
    expect(await source.day(20738)).toBeNull();
  });

  it('follows next past a chunk shorter than the limit', async () => {
    const day = chainDayFixture();
    const gw = fakeGateway(day, { pageRows: 1 });
    const source = new GatewayTdhChainSource(BASE, gw.fetcher, 4);
    const read = await readChainDay(source, day.header.cycleDay);
    expect(read?.walletLeaves).toEqual(day.walletLeaves);
    expect(read?.tokenLeaves).toEqual(day.tokenLeaves);
    const w = day.walletLeaves.map((l) => l.wallet);
    const lists = gw.requests.map(pathOf).filter((p) => p.includes('/wallets'));
    expect(lists).toEqual(
      w.map(
        (_, i) =>
          `/v1/tdh/days/20737/wallets?${i === 0 ? '' : `after=${w[i - 1]}&`}limit=4&height=${H}`
      )
    );
  });

  it('reads no token list while the gateway serves none', async () => {
    const day = chainDayFixture();
    const source = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, { tokens: false }).fetcher
    );
    expect((await readChainDay(source, 20737))!.tokenLeaves).toBeNull();
    expect(source.noTokenListReason(20737)).toBe(
      'the gateway has no token route'
    );
  });

  it("refuses a wallet list that does not rebuild the day's root", async () => {
    const day = chainDayFixture();
    const rows = day.walletLeaves.map(walletRow);
    rows[2] = {
      ...rows[2],
      walletTdh: String(day.walletLeaves[2].walletTdh + 1)
    };
    const source = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, { walletRows: rows }).fetcher
    );
    await expect(source.walletLeaves(20737)).rejects.toThrow(/walletRoot/);
  });

  it('refuses a chunk that names another root or count than its day', async () => {
    const day = chainDayFixture();
    const source = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, {
        chunk: (data) => ({ ...data, walletCount: data.walletCount + 1 })
      }).fetcher
    );
    await expect(source.walletLeaves(20737)).rejects.toThrow(/walletCount/);
  });

  it('reads the list again at a fresh pin when the pinned height is gone', async () => {
    const day = chainDayFixture();
    const gw = fakeGateway(day, { gone: [H] });
    const source = new GatewayTdhChainSource(BASE, gw.fetcher, 2);
    await source.day(20737);
    gw.advance(H + 70);
    expect(await source.walletLeaves(20737)).toEqual(day.walletLeaves);
    const heights = gw.requests
      .map((u) => new URL(u))
      .filter((u) => u.pathname.endsWith('/wallets'))
      .map((u) => Number(u.searchParams.get('height')));
    expect(heights).toEqual([H, H + 70, H + 70, H + 70]);
  });

  it('reads the list again at a fresh pin when a chunk is gone, as from a second node', async () => {
    const day = chainDayFixture();
    let dropped = 0;
    const gw = fakeGateway(day, {
      drop: (url) => url.searchParams.get('after') !== null && dropped++ === 0
    });
    const source = new GatewayTdhChainSource(BASE, gw.fetcher, 2);
    await source.day(20737);
    gw.advance(H + 5);
    expect(await source.walletLeaves(20737)).toEqual(day.walletLeaves);
    expect(dropped).toBeGreaterThan(1);
  });

  it('fails loudly on a route the gateway does not have', async () => {
    const day = chainDayFixture();
    const wrong = new GatewayTdhChainSource(
      `${BASE}/api`,
      fakeGateway(day).fetcher
    );
    await expect(wrong.latestDay()).rejects.toThrow(TdhGatewayRouteError);
    await expect(wrong.day(20737)).rejects.toThrow(TdhGatewayRouteError);
  });

  it('asks for a token list again after a 404, as from a node that got the day by handover', async () => {
    const day = chainDayFixture();
    let refused = 0;
    const gw = fakeGateway(day, {
      drop: (url) => url.pathname.endsWith('/tokens') && refused++ < 2
    });
    const source = new GatewayTdhChainSource(BASE, gw.fetcher);
    expect(await source.tokenLeaves(20737)).toEqual(day.tokenLeaves);
    expect(refused).toBe(3);
    const always = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, { drop: (url) => url.pathname.endsWith('/tokens') })
        .fetcher
    );
    expect(await always.tokenLeaves(20737)).toBeNull();
    expect(always.noTokenListReason(20737)).toBe(
      'the gateway served no token list for the day (404, 3 tries)'
    );
    expect(source.noTokenListReason(20737)).toBeNull();
  });

  it('reads a token answer it cannot read as no token list', async () => {
    const day = chainDayFixture();
    const odd = day.tokenLeaves!.map((t) => ({
      ...tokenRow(t),
      tokenTdh: { value: t.tokenTdh }
    }));
    const source = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, { tokenRows: odd }).fetcher
    );
    const read = await readChainDay(source, 20737);
    expect(read!.tokenLeaves).toBeNull();
    expect(read!.walletLeaves).toEqual(day.walletLeaves);
    expect(source.noTokenListReason(20737)).toMatch(
      /^the gateway served a token list, refused: tokenTdh/
    );
  });

  it('gives up after three pins that are gone', async () => {
    const day = chainDayFixture();
    const gw = fakeGateway(day, { gone: [H] });
    const source = new GatewayTdhChainSource(BASE, gw.fetcher, 2);
    await expect(source.walletLeaves(20737)).rejects.toThrow(/pinned height/);
  });

  it('reads no latest day before the chain has applied one', async () => {
    const fetcher = new RateLimitedFetcher({
      allowedHosts: ['gateway.example'],
      minIntervalMs: 0,
      retries: 0,
      fetchFn: async () =>
        Response.json({ read: readStamp(H), data: null, next: null })
    });
    const source = new GatewayTdhChainSource(BASE, fetcher);
    expect(await source.latestDay()).toBeNull();
    expect(await source.day(20737)).toBeNull();
  });

  it("reports the gateway's 503 while no node serves, in plain words", async () => {
    const fetcher = new RateLimitedFetcher({
      allowedHosts: ['gateway.example'],
      minIntervalMs: 0,
      retries: 0,
      fetchFn: async () =>
        Response.json(
          {
            error: 'nodes_unavailable',
            message: 'no API node is serving right now; try again shortly'
          },
          { status: 503, headers: { 'Retry-After': '10' } }
        )
    });
    const source = new GatewayTdhChainSource(BASE, fetcher);
    const error = await source.latestDay().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TdhChainSourceError);
    expect(error).not.toBeInstanceOf(TdhGatewayRouteError);
    expect((error as Error).message).toBe(
      '/v1/tdh: nodes_unavailable: no API node is serving right now; try again shortly'
    );
  });

  it('names the HTTP status when a refusal says nothing', async () => {
    const fetcher = new RateLimitedFetcher({
      allowedHosts: ['gateway.example'],
      minIntervalMs: 0,
      retries: 0,
      fetchFn: async () => Response.json({ error: {} }, { status: 500 })
    });
    await expect(
      new GatewayTdhChainSource(BASE, fetcher).latestDay()
    ).rejects.toThrow('/v1/tdh: HTTP 500');
  });

  it('reports a refusal with its code', async () => {
    const fetcher = new RateLimitedFetcher({
      allowedHosts: ['gateway.example'],
      minIntervalMs: 0,
      retries: 0,
      fetchFn: async () =>
        Response.json(
          { error: { code: 'starting', message: 'reading the chain' } },
          { status: 503 }
        )
    });
    const source = new GatewayTdhChainSource(BASE, fetcher);
    await expect(source.latestDay()).rejects.toThrow(
      'starting: reading the chain'
    );
  });
});

describe('FileTdhChainSource', () => {
  it('reads day files from a folder', async () => {
    const day = chainDayFixture();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdh-chain-'));
    await fs.writeFile(
      path.join(dir, walletDayFileName(20737)),
      formatWalletDayFile(day)
    );
    await fs.writeFile(
      path.join(dir, tokenDayFileName(20737)),
      formatTokenDayFile(day)
    );
    const source = new FileTdhChainSource(dir);
    expect((await source.latestDay())!.header.cycleDay).toBe(20737);
    expect(await readChainDay(source, 20737)).toEqual(day);
    expect(await readChainDay(source, 20738)).toBeNull();
    expect(walletDayFileName(20781)).toBe('tdh-chain-20261124-wallets.csv');
  });
});
