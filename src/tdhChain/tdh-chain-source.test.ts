import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    chunk?: (data: any) => any;
  } = {}
) {
  let height = H;
  const requests: string[] = [];
  const json = (status: number, body: unknown) =>
    Response.json(body, { status });
  const notFound = () =>
    json(404, {
      read: readStamp(height),
      error: { code: 'not_found', message: 'no such day' }
    });
  const list = (url: URL, rows: any[], extra: Record<string, unknown>) => {
    const pin = Number(url.searchParams.get('height'));
    if ((opts.gone ?? []).includes(pin)) {
      return json(409, {
        read: readStamp(height),
        error: {
          code: 'height_gone',
          message: `holds ${height - 64}..${height}`
        }
      });
    }
    const limit = Number(url.searchParams.get('limit'));
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
      return list(url, day.tokenLeaves!.map(tokenRow), {
        tokenRoot: day.header.tokenRoot,
        tokenCount: day.header.tokenCount
      });
    }
    return notFound();
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
    expect(() => decodeTokenRows([{ ...t, tokenId: '0x1' }])).toThrow();
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

  it('reads no token list while the gateway serves none', async () => {
    const day = chainDayFixture();
    const source = new GatewayTdhChainSource(
      BASE,
      fakeGateway(day, { tokens: false }).fetcher
    );
    expect((await readChainDay(source, 20737))!.tokenLeaves).toBeNull();
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
