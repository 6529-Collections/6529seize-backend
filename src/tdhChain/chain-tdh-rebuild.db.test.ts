import 'reflect-metadata';
import { createHash } from 'crypto';
import {
  CONSOLIDATIONS_TABLE,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import {
  connect,
  disconnect,
  fetchAllConsolidatedTdh,
  fetchAllTDH
} from '@/db';
import { fetchBlocks } from '@/db-api';
import * as Entities from '@/entities/entities';
import { ConsolidatedTDH, TDH } from '@/entities/ITDH';
import { setSqlExecutor, SqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { runTdhHistoryForDate } from '@/tdhHistoryLoop';
import { findNftTDH } from '@/tdhLoop/nft_tdh';
import { updateTDH } from '@/tdhLoop/tdh';
import { consolidateAndPersistTDH } from '@/tdhLoop/tdh_consolidation';
import { uploadTDH } from '@/tdhLoop/tdh_upload';
import { siteIngestDeps, siteStepRunner } from './chain-tdh-ingest.deps';
import {
  ChainDayStepRunner,
  ChainTdhIngestDeps,
  ingestChainDay,
  runFollowUpSteps
} from './chain-tdh-ingest';
import { parseCsv } from './csv';
import { cidOf, compareText, tokenRoot, walletRoot } from './p28';
import { COLLECTION_CONTRACTS, SITE_COLLECTIONS } from './site-day';
import { CHAIN_DAY_STEPS, tdhChainDaysDb } from './tdh-chain-days.db';
import { pollChainDays } from './tdh-chain-day-poller';
import { sitePollerDeps } from './chain-tdh-ingest.deps';
import { TdhChainSource } from './tdh-chain-source';
import { TdhChainDay, TdhTokenLeaf, TdhWalletLeaf } from './tdh-chain.types';

/**
 * The rebuild test (DESIGN.md section 5): the old path computes two TDH
 * days from a small Ethereum index and writes every TDH table. The chain
 * days are built from what it wrote, as the chain would hold them. Then the
 * TDH tables are emptied and the chain path ingests both days from them.
 * Every TDH table must read the same as the old path left it, apart from
 * the columns that record when a row was written.
 */

const mockUploaded = new Map<string, string>();

// Arweave stand-in: the URL is a hash of the bytes, so equal URLs mean equal
// files, and the bytes stay readable for the comparison.
jest.mock('@/tdhLoop/tdh-arweave-upload', () => ({
  uploadTdhCsvToArweave: jest.fn(async (csv: string) => {
    const id = createHash('sha256').update(csv).digest('hex').slice(0, 43);
    const url = `https://arweave.net/${id}`;
    mockUploaded.set(url, csv);
    return { url, transactionId: id };
  })
}));

/**
 * An uploaded CSV as rows of values, JSON cells parsed. The old path builds
 * the wallet file from rows in memory and the chain path from rows read back
 * from MySQL, which orders JSON keys its own way, so the two files hold the
 * same values with object keys in another order.
 */
function uploadedRows(url: unknown): unknown {
  const csv = mockUploaded.get(String(url));
  if (csv === undefined) return `not uploaded: ${String(url)}`;
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) =>
    Object.fromEntries(
      r.map((cell, i) => [
        header[i],
        /^[[{]/.test(cell) ? JSON.parse(cell) : cell
      ])
    )
  );
}

const MEMES = MEMES_CONTRACT.toLowerCase();
const GRADIENTS = GRADIENT_CONTRACT.toLowerCase();
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const W1 = w(0xa01);
const W2 = w(0xa02);
const W3 = w(0xa03);

const DAY_1 = 20737; // 11 Oct 2026
const DAY_2 = 20738;
const BLOCK_1 = 1000;
const BLOCK_2 = 1100;
const cutoffTime = (day: number) => new Date(day * 86_400_000 - 1000);

const utc = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');

function nft(id: number, contract: string) {
  return {
    id,
    contract,
    created_at: utc('2026-08-31T00:00:00Z'),
    mint_date: utc('2026-08-31T00:00:00Z'),
    mint_price: 0,
    supply: 10,
    name: `token ${id}`,
    collection: 'fixture',
    token_type: 'ERC1155',
    description: '',
    artist: '',
    artist_seize_handle: '',
    floor_price: 0,
    market_cap: 0,
    total_volume_last_24_hours: 0,
    total_volume_last_7_days: 0,
    total_volume_last_1_month: 0,
    total_volume: 0,
    highest_offer: 0,
    edition_size_floor: 0,
    hodl_rate: 1,
    boosted_tdh: 0,
    tdh: 0,
    tdh__raw: 0,
    tdh_rank: 0
  };
}

function mint(
  hash: string,
  block: number,
  iso: string,
  to: string,
  contract: string,
  tokenId: number
) {
  return {
    created_at: utc(iso),
    transaction: hash,
    block,
    transaction_date: utc(iso),
    from_address: NULL_ADDRESS,
    to_address: to,
    contract,
    token_id: tokenId,
    token_count: 1,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0
  };
}

const SEEDS = [
  {
    table: NFTS_TABLE,
    rows: [nft(1, MEMES), nft(2, MEMES), nft(1, GRADIENTS)]
  },
  {
    table: MEMES_SEASONS_TABLE,
    rows: [
      {
        id: 1,
        created_at: utc('2026-08-01T00:00:00Z'),
        start_index: 1,
        end_index: 2,
        count: 2,
        name: 'SZN1',
        display: 'SZN1',
        boost: 0.05
      }
    ]
  },
  {
    table: TRANSACTIONS_TABLE,
    rows: [
      mint(`0x${'1'.repeat(64)}`, 100, '2026-09-01T00:00:00Z', W1, MEMES, 1),
      mint(`0x${'2'.repeat(64)}`, 110, '2026-09-05T00:00:00Z', W2, MEMES, 1),
      mint(`0x${'3'.repeat(64)}`, 120, '2026-09-10T00:00:00Z', W3, MEMES, 2),
      mint(
        `0x${'4'.repeat(64)}`,
        130,
        '2026-09-12T00:00:00Z',
        W3,
        GRADIENTS,
        1
      ),
      mint(`0x${'5'.repeat(64)}`, 1050, '2026-10-11T05:00:00Z', W1, MEMES, 2)
    ]
  },
  {
    table: CONSOLIDATIONS_TABLE,
    rows: [
      {
        created_at: utc('2026-08-01T00:00:00Z'),
        block: 50,
        wallet1: W1,
        wallet2: W2,
        confirmed: true,
        wallet1_registered_at: 1_780_000_000,
        wallet2_registered_at: 1_780_000_000
      }
    ]
  }
];

/** The chain's day as it would hold what the site wrote. */
function chainDayOf(
  cycleDay: number,
  block: number,
  wallets: TDH[],
  consolidated: ConsolidatedTDH[]
): TdhChainDay {
  const groupOf = new Map<string, ConsolidatedTDH>();
  for (const c of consolidated) {
    for (const x of c.wallets as string[]) groupOf.set(x.toLowerCase(), c);
  }
  const walletLeaves: TdhWalletLeaf[] = wallets
    .map((row) => {
      const group = groupOf.get(row.wallet.toLowerCase())!;
      const members = (group.wallets as string[])
        .map((x) => x.toLowerCase())
        .sort(compareText);
      return {
        wallet: row.wallet.toLowerCase(),
        cid: cidOf(members),
        identityTdh: group.boosted_tdh,
        walletTdh: row.boosted_tdh,
        walletCount: members.length
      };
    })
    .sort((a, b) => compareText(a.wallet, b.wallet));
  const tokenLeaves: TdhTokenLeaf[] = [];
  for (const c of consolidated) {
    const cid = cidOf(
      (c.wallets as string[]).map((x) => x.toLowerCase()).sort(compareText)
    );
    for (const collection of SITE_COLLECTIONS) {
      for (const t of (c as any)[collection] ?? []) {
        const v = Math.round(t.tdh * c.boost);
        if (v > 0) {
          tokenLeaves.push({
            cid,
            contract: COLLECTION_CONTRACTS[collection],
            tokenId: String(t.id),
            tokenTdh: v
          });
        }
      }
    }
  }
  tokenLeaves.sort(
    (a, b) =>
      compareText(a.cid, b.cid) ||
      compareText(a.contract, b.contract) ||
      Number(BigInt(a.tokenId) - BigInt(b.tokenId))
  );
  return {
    header: {
      cycleDay,
      boundary: cycleDay * 86400,
      tdhRuleId: `0x${'ab'.repeat(32)}`,
      cutoffNumber: block,
      cutoffHash: `0x${block.toString(16).padStart(64, '0')}`,
      cutoffTimestamp: cycleDay * 86400 - 1,
      walletRoot: walletRoot(walletLeaves),
      walletCount: walletLeaves.length,
      identityCount: consolidated.length,
      totalTdh: consolidated.reduce((s, c) => s + c.boosted_tdh, 0),
      tokenRoot: tokenRoot(tokenLeaves),
      tokenCount: tokenLeaves.length
    },
    apply: {
      applyHeight: 10,
      applyBlockHash: `0x${'cd'.repeat(32)}`,
      applyTimeMs: cycleDay * 86_400_000 + 1_800_000,
      finalizedHeight: 20
    },
    walletLeaves,
    tokenLeaves
  };
}

async function oldPathDay(cycleDay: number, block: number) {
  const ts = cutoffTime(cycleDay);
  const r = await updateTDH(ts, undefined, {
    block: { number: block, timestamp: ts }
  });
  const consolidated = await consolidateAndPersistTDH(block, ts, {
    mode: 'FULL'
  });
  await findNftTDH();
  await uploadTDH(block, ts, r.tdh, false, true);
  await uploadTDH(block, ts, consolidated, true, true);
  await runTdhHistoryForDate(new Date(cycleDay * 86_400_000), {
    fallback: false
  }).catch(() => undefined);
}

const TABLES: { table: string; order: string; skip: string[] }[] = [
  { table: 'tdh', order: 'block, wallet', skip: [] },
  { table: 'tdh_consolidation', order: 'consolidation_key', skip: ['date'] },
  { table: 'tdh_memes', order: 'wallet, season', skip: [] },
  {
    table: 'tdh_memes_consolidation',
    order: 'consolidation_key, season',
    skip: []
  },
  {
    table: 'tdh_editions',
    order: 'wallet, contract, id, edition_id',
    skip: []
  },
  {
    table: 'tdh_editions_consolidation',
    order: 'consolidation_key, contract, id, edition_id',
    skip: []
  },
  { table: 'tdh_nft', order: 'consolidation_key, contract, id', skip: [] },
  {
    table: 'historic_tdh_consolidation',
    order: 'block, consolidation_key',
    skip: ['date']
  },
  { table: 'tdh_blocks', order: 'block_number', skip: ['created_at'] },
  { table: 'tdh_history', order: 'date, consolidation_key', skip: [] },
  { table: 'tdh_global_history', order: 'date', skip: [] },
  { table: 'recent_tdh_history', order: 'date, consolidation_key', skip: [] },
  { table: 'latest_tdh_history', order: 'date, consolidation_key', skip: [] },
  { table: 'latest_tdh_global_history', order: 'date', skip: [] },
  {
    table: 'nextgen_tokens_tdh',
    order: 'id, consolidation_key',
    skip: ['created_at', 'updated_at']
  },
  { table: 'uploads', order: 'date', skip: ['timestamp'] },
  { table: 'uploads_consolidation', order: 'date', skip: ['timestamp'] }
];
const UPLOAD_TABLES = new Set(['uploads', 'uploads_consolidation']);

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const rows = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${t.table} order by ${t.order}`
    );
    out[t.table] = rows.map((r) => {
      const copy: Record<string, unknown> = { ...r };
      t.skip.forEach((c) => delete copy[c]);
      if (UPLOAD_TABLES.has(t.table)) copy.tdh = uploadedRows(copy.tdh);
      return copy;
    });
  }
  out.nfts = await sqlExecutor.execute(
    `select id, contract, tdh, boosted_tdh, tdh__raw, tdh_rank from ${NFTS_TABLE} order by contract, id`
  );
  return out;
}

async function emptyTdhTables() {
  for (const t of TABLES) await sqlExecutor.execute(`delete from ${t.table}`);
  await sqlExecutor.execute(`delete from tdh_chain_days`);
  await sqlExecutor.execute(
    `update ${NFTS_TABLE} set tdh = 0, boosted_tdh = 0, tdh__raw = 0, tdh_rank = 0`
  );
}

function memorySource(days: TdhChainDay[]): TdhChainSource {
  const byDay = new Map(days.map((d) => [d.header.cycleDay, d]));
  return {
    latestDay: async () => {
      const d = days[days.length - 1];
      return d ? { header: d.header, apply: d.apply } : null;
    },
    day: async (n) => {
      const d = byDay.get(n);
      return d ? { header: d.header, apply: d.apply } : null;
    },
    walletLeaves: async (n) => byDay.get(n)!.walletLeaves.slice(),
    tokenLeaves: async (n) => byDay.get(n)!.tokenLeaves?.slice() ?? null
  };
}

function chainDeps(days: TdhChainDay[]): ChainTdhIngestDeps & {
  steps: ChainDayStepRunner;
} {
  const real = siteIngestDeps();
  return {
    steps: siteStepRunner(memorySource(days)),
    ...real,
    ethBlocks: {
      getBlock: async (n) => {
        const day = days.find((d) => d.header.cutoffNumber === n);
        if (day) {
          return {
            hash: day.header.cutoffHash,
            timestamp: day.header.cutoffTimestamp
          };
        }
        const before = days.find((d) => d.header.cutoffNumber + 1 === n)!;
        return { hash: '0x00', timestamp: before.header.boundary + 12 };
      }
    },
    transactionsIndexedTo: async () => Number.MAX_SAFE_INTEGER,
    now: () => DAY_2 * 86_400_000 + 3_600_000
  };
}

/** The chain path as the poller runs it: the write, then its steps. */
async function ingestDay(day: TdhChainDay, deps: ReturnType<typeof chainDeps>) {
  const r = await ingestChainDay(day, 'CHAIN', deps);
  if (r.status === 'WRITTEN') {
    const steps = await runFollowUpSteps(
      {
        cycleDay: day.header.cycleDay,
        block: day.header.cutoffNumber,
        stepsDone: [],
        stepsGivenUp: []
      },
      deps.steps,
      async (title) => {
        throw new Error(title);
      }
    );
    expect(steps.failed).toEqual([]);
  }
  return r;
}

/** Day `day` with one identity's values raised by `by` on the chain. */
function raised(day: TdhChainDay, wallet: string, by: number): TdhChainDay {
  const walletLeaves = day.walletLeaves.map((l) =>
    l.wallet === wallet
      ? { ...l, walletTdh: l.walletTdh + by, identityTdh: l.identityTdh + by }
      : l
  );
  return {
    ...day,
    header: {
      ...day.header,
      walletRoot: walletRoot(walletLeaves),
      totalTdh: day.header.totalTdh + by
    },
    walletLeaves
  };
}

describeWithSeed('rebuilding the TDH tables from the 6529 chain', SEEDS, () => {
  let appExecutor: SqlExecutor;

  beforeAll(async () => {
    // The app's own data source and executor: the TDH loop reads through
    // TypeORM repositories and writes in TypeORM transactions.
    await connect(
      Object.values(Entities).filter((e) => typeof e === 'function')
    );
    appExecutor = sqlExecutor;
  });

  afterAll(async () => {
    await disconnect();
  });

  beforeEach(() => {
    setSqlExecutor(appExecutor);
    process.env.ARWEAVE_KEY = '{}';
    delete process.env.FEATURE_TDH_CHAIN_SHADOW;
    delete process.env.FEATURE_TDH_FROM_CHAIN;
  });

  it('gives the same tables as the old path, from empty', async () => {
    await oldPathDay(DAY_1, BLOCK_1);
    const day1 = chainDayOf(
      DAY_1,
      BLOCK_1,
      (await fetchAllTDH(BLOCK_1)) as TDH[],
      await fetchAllConsolidatedTdh()
    );
    await oldPathDay(DAY_2, BLOCK_2);
    const day2 = chainDayOf(
      DAY_2,
      BLOCK_2,
      (await fetchAllTDH(BLOCK_2)) as TDH[],
      await fetchAllConsolidatedTdh()
    );
    const old = await snapshot();
    expect(old.tdh_consolidation).toHaveLength(2);
    expect(old.tdh).toHaveLength(6);
    expect(old.tdh_history.length).toBeGreaterThan(0);

    await emptyTdhTables();
    const deps = chainDeps([day1, day2]);
    const r1 = await ingestDay(day1, deps);
    const r2 = await ingestDay(day2, deps);
    expect([r1.status, r1.verdict]).toEqual(['WRITTEN', 'MATCH']);
    expect([r2.status, r2.verdict]).toEqual(['WRITTEN', 'MATCH']);

    const rebuilt = await snapshot();
    for (const t of Object.keys(old)) {
      expect({ table: t, rows: rebuilt[t] }).toEqual({
        table: t,
        rows: old[t]
      });
    }
    const uploadUrls = async () =>
      sqlExecutor.execute(
        `select date, tdh from uploads union all select date, tdh from uploads_consolidation order by date, tdh`
      );
    const firstUrls = await uploadUrls();

    // A second rebuild from empty writes the same tables and byte-identical
    // files.
    await emptyTdhTables();
    await ingestDay(day1, deps);
    await ingestDay(day2, deps);
    expect(await snapshot()).toEqual(rebuilt);
    expect(await uploadUrls()).toEqual(firstUrls);

    const recorded = await sqlExecutor.execute<{
      cycle_day: number;
      status: string;
      steps_done: string;
      wallets_file_url: string | null;
    }>(
      `select cycle_day, status, steps_done, wallets_file_url from tdh_chain_days order by cycle_day`
    );
    expect(recorded.map((r) => [Number(r.cycle_day), r.status])).toEqual([
      [DAY_1, 'INGESTED'],
      [DAY_2, 'INGESTED']
    ]);
    expect(JSON.parse(recorded[1].steps_done)).toEqual([...CHAIN_DAY_STEPS]);
    expect(recorded[1].wallets_file_url).toMatch(/^https:\/\/arweave\.net\//);
  }, 180_000);

  it('writes the chain values where they differ, uploads a day written again, and gives a block the old path writes again back to SITE', async () => {
    await oldPathDay(DAY_1, BLOCK_1);
    const day1 = chainDayOf(
      DAY_1,
      BLOCK_1,
      (await fetchAllTDH(BLOCK_1)) as TDH[],
      await fetchAllConsolidatedTdh()
    );
    await oldPathDay(DAY_2, BLOCK_2);
    const siteW3 = ((await fetchAllTDH(BLOCK_2)) as TDH[]).find(
      (r) => r.wallet.toLowerCase() === W3
    )!.boosted_tdh;
    const day2 = chainDayOf(
      DAY_2,
      BLOCK_2,
      (await fetchAllTDH(BLOCK_2)) as TDH[],
      await fetchAllConsolidatedTdh()
    );
    const day2Raised = raised(day2, W3, 7);

    await emptyTdhTables();
    const deps = chainDeps([day1, day2]);
    await ingestDay(day1, deps);
    await ingestDay(day2, deps);
    const w3Upload = async () =>
      (
        uploadedRows(
          (
            await sqlExecutor.execute<{ tdh: string }>(
              `select tdh from uploads where block = ${BLOCK_2}`
            )
          )[0]?.tdh
        ) as Record<string, string>[]
      ).find((r) => r.wallet.toLowerCase() === W3)!.boosted_tdh;
    expect(Number(await w3Upload())).toBe(siteW3);

    // The same day again with other values: written over, uploaded again.
    const r = await ingestDay(day2Raised, chainDeps([day1, day2Raised]));
    expect([r.status, r.verdict]).toEqual(['WRITTEN', 'MISMATCH']);
    const w3 = ((await fetchAllTDH(BLOCK_2)) as TDH[]).find(
      (x) => x.wallet.toLowerCase() === W3
    )!;
    expect(w3.boosted_tdh).toBe(siteW3 + 7);
    const w3Identity = (await fetchAllConsolidatedTdh()).find(
      (c) => c.consolidation_key === W3
    )!;
    expect(w3Identity.boosted_tdh).toBe(siteW3 + 7);
    expect(Number(await w3Upload())).toBe(siteW3 + 7);
    const chainBlock = async () =>
      (await fetchBlocks(10, 1)).data.find((b) => b.block_number === BLOCK_2)!;
    expect(Number((await chainBlock()).chain_cycle_day)).toBe(DAY_2);

    // A same-day rollback: the old path writes the chain's block again.
    await oldPathDay(DAY_2, BLOCK_2);
    expect((await chainBlock()).chain_cycle_day).toBeNull();
    expect(
      ((await fetchAllTDH(BLOCK_2)) as TDH[]).find(
        (x) => x.wallet.toLowerCase() === W3
      )!.boosted_tdh
    ).toBe(siteW3);
    expect(await tdhChainDaysDb.pendingDays()).toEqual([]);
    const latest = await tdhChainDaysDb.latest();
    expect(latest).toMatchObject({ cycleDay: DAY_2, superseded: true });
  }, 180_000);

  it('writes a day once: an older day is skipped, and nothing runs while both flags are off', async () => {
    await oldPathDay(DAY_1, BLOCK_1);
    const day1 = chainDayOf(
      DAY_1,
      BLOCK_1,
      (await fetchAllTDH(BLOCK_1)) as TDH[],
      await fetchAllConsolidatedTdh()
    );
    await oldPathDay(DAY_2, BLOCK_2);
    const before = await snapshot();

    expect(await pollChainDays(sitePollerDeps())).toEqual({});
    const deps = chainDeps([day1]);
    const r = await ingestChainDay(day1, 'CHAIN', deps);
    expect(r.status).toBe('SKIPPED');
    expect(await snapshot()).toEqual(before);
  }, 180_000);
});
