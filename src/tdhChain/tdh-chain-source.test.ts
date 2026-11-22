import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBytes } from 'ethers';
import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import { RateLimitedFetcher } from './rate-limited-fetcher';
import { formatTokenDayFile, formatWalletDayFile } from './tdh-day-file';
import {
  decodeDayInfo,
  decodeTokenLeaves,
  decodeWalletLeaves,
  FileTdhChainSource,
  GatewayTdhChainSource,
  readChainDay,
  tokenDayFileName,
  walletDayFileName
} from './tdh-chain-source';
import { TdhChainDay } from './tdh-chain.types';

function be(v: bigint | number, bytes: number): number[] {
  let x = BigInt(v);
  const out = new Array<number>(bytes).fill(0);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(x & BigInt(0xff));
    x >>= BigInt(8);
  }
  return out;
}

/** The gateway's CE encodings of a day's lists. */
function encodeLists(day: TdhChainDay) {
  const wallets = day.walletLeaves.flatMap((l) => [
    ...Array.from(getBytes(l.wallet)),
    ...Array.from(getBytes(l.cid)),
    ...be(l.identityTdh, 8),
    ...be(l.walletTdh, 8),
    l.walletCount
  ]);
  const tokens = day.tokenLeaves!.flatMap((t) => [
    ...Array.from(getBytes(t.cid)),
    ...Array.from(getBytes(t.contract)),
    ...be(BigInt(t.tokenId), 32),
    ...be(t.tokenTdh, 8)
  ]);
  return { wallets: new Uint8Array(wallets), tokens: new Uint8Array(tokens) };
}

function dayJson(day: TdhChainDay) {
  const h = day.header;
  return {
    cycle_day: h.cycleDay,
    boundary: h.boundary,
    tdh_rule_id: h.tdhRuleId,
    cutoff_number: String(h.cutoffNumber),
    cutoff_hash: h.cutoffHash.toUpperCase().replace('0X', '0x'),
    cutoff_timestamp: h.cutoffTimestamp,
    wallet_root: h.walletRoot,
    wallet_count: h.walletCount,
    identity_count: h.identityCount,
    total_tdh: h.totalTdh,
    token_root: h.tokenRoot,
    token_count: h.tokenCount,
    apply_height: day.apply.applyHeight,
    apply_block_hash: day.apply.applyBlockHash,
    apply_time_ms: day.apply.applyTimeMs,
    finalized_height: day.apply.finalizedHeight
  };
}

describe('gateway decoders', () => {
  it('decodes CE wallet and token leaves', () => {
    const day = chainDayFixture();
    const { wallets, tokens } = encodeLists(day);
    expect(wallets.length).toBe(69 * 5);
    expect(decodeWalletLeaves(wallets)).toEqual(day.walletLeaves);
    expect(decodeTokenLeaves(tokens)).toEqual(day.tokenLeaves);
    expect(() => decodeWalletLeaves(wallets.subarray(1))).toThrow();
    expect(() => decodeTokenLeaves(tokens.subarray(3))).toThrow();
  });

  it('refuses a value above 2^53 - 1', () => {
    const bytes = encodeLists(chainDayFixture()).wallets;
    bytes.set(be(BigInt(1) << BigInt(60), 8), 52);
    expect(() => decodeWalletLeaves(bytes)).toThrow();
  });

  it('decodes a day, lowercasing hashes and taking integers as text too', () => {
    const day = chainDayFixture();
    expect(decodeDayInfo(dayJson(day))).toEqual({
      header: day.header,
      apply: day.apply
    });
    expect(
      decodeDayInfo({ ...dayJson(day), apply_height: null }).apply.applyHeight
    ).toBeNull();
    expect(() => decodeDayInfo({ ...dayJson(day), total_tdh: -1 })).toThrow();
    expect(() =>
      decodeDayInfo({ ...dayJson(day), wallet_root: '0x12' })
    ).toThrow();
  });
});

describe('GatewayTdhChainSource', () => {
  it('reads a day through the provisional routes', async () => {
    const day = chainDayFixture();
    const { wallets, tokens } = encodeLists(day);
    const base = 'https://gateway.example';
    const answers: Record<string, () => Response> = {
      [`${base}/v1/tdh/days/latest`]: () => Response.json(dayJson(day)),
      [`${base}/v1/tdh/days/20737`]: () => Response.json(dayJson(day)),
      [`${base}/v1/tdh/days/20737/wallets`]: () => new Response(wallets),
      [`${base}/v1/tdh/days/20737/tokens`]: () => new Response(tokens)
    };
    const fetcher = new RateLimitedFetcher({
      allowedHosts: ['gateway.example'],
      minIntervalMs: 0,
      fetchFn: async (url) =>
        answers[url] ? answers[url]() : new Response('', { status: 404 })
    });
    const source = new GatewayTdhChainSource(`${base}/`, fetcher);
    expect((await source.latestDay())!.header).toEqual(day.header);
    expect(await readChainDay(source, 20737)).toEqual(day);
    expect(await source.day(20738)).toBeNull();
    delete answers[`${base}/v1/tdh/days/20737/tokens`];
    expect(await source.tokenLeaves(20737)).toBeNull();
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
