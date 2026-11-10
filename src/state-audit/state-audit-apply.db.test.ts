import 'reflect-metadata';
import {
  ETH_PRICE_TABLE,
  NFT_OWNERS_TABLE,
  NULL_ADDRESS,
  STATE_AUDIT_JOBS_TABLE,
  TRANSACTIONS_TABLE,
  TRANSFER_RECONCILIATIONS_TABLE
} from '@/constants';
import type { DbQueryOptions } from '@/db-query.options';
import type { Block, Log } from '@/ethereum-rpc/ethereum-rpc-types';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import {
  blockHashOf,
  erc1155TransferBatchLog,
  erc1155TransferSingleLog,
  txHashOf
} from '@/tests/fixtures/nft-transfer-log.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { TransferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { StateAuditApplyDb } from './state-audit-apply.db';
import type { StateAuditApplyRequest } from './state-audit-apply.options';
import {
  ApplyReceipt,
  ReconciliationEnqueuer,
  runStateAuditApply,
  StateAuditApplyDeps,
  StateAuditApplyRpc
} from './state-audit-apply.service';
import { StateAuditDb } from './state-audit.db';
import {
  computePlanDigest,
  Discrepancy,
  StateAuditManifest
} from './state-audit.manifest';
import type { StateAuditRequest } from './state-audit.options';
import { runStateAudit } from './state-audit.service';

const MEMES = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const ZERO = NULL_ADDRESS.toLowerCase();
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const CAROL = '0x4444444444444444444444444444444444444444';
const DAVE = '0x5555555555555555555555555555555555555555';
const FROM_BLOCK = 1_000;
const TO_BLOCK = 1_010;
const OWNERS_BLOCK = 2_000;
const MINT_TX = txHashOf(1);
const SALE_TX = txHashOf(2);
const GIFT_TX = txHashOf(3);
const BOGUS_TX = txHashOf(4);
const JOB_ID = '7d0f3c1e-8b2a-4c5d-9e6f-0a1b2c3d4e5f';
const BASE_TIMESTAMP = 1_700_000_000;
const ETH_PRICE = 2_000;

/** Fails the test on any statement that is not a SELECT or on any transaction. */
class MutationGuard extends SqlExecutor {
  readonly statements: string[] = [];
  constructor(private readonly delegate: SqlExecutor) {
    super();
  }
  async execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    this.statements.push(sql);
    if (!/^\s*SELECT\b/i.test(sql)) {
      throw new Error(`dry-run executed a non-SELECT statement: ${sql}`);
    }
    return this.delegate.execute<T>(sql, params, options);
  }
  async executeNativeQueriesInTransaction<T>(
    _executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>,
    _options?: SqlTransactionOptions
  ): Promise<T> {
    throw new Error('dry-run opened a transaction');
  }
}

function block(number: number, hash: string = blockHashOf(number)): Block {
  return {
    number,
    hash,
    parentHash: blockHashOf(number - 1),
    timestamp: BASE_TIMESTAMP + number,
    nonce: '0x0',
    difficulty: BigInt(0),
    gasLimit: BigInt(0),
    gasUsed: BigInt(0),
    miner: ALICE,
    extraData: '0x',
    baseFeePerGas: null,
    transactions: []
  };
}

/** A 5-unit mint to Alice, a 2-unit sale to Bob (two logs), a gift to Carol. */
function chainLogs(): Log[] {
  return [
    erc1155TransferSingleLog(MEMES, ZERO, ALICE, 1, 5, {
      blockNumber: 1_001,
      transactionHash: MINT_TX,
      logIndex: 0
    }),
    erc1155TransferSingleLog(MEMES, ALICE, BOB, 1, 1, {
      blockNumber: 1_005,
      transactionHash: SALE_TX,
      transactionIndex: 3,
      logIndex: 7
    }),
    erc1155TransferBatchLog(MEMES, ALICE, BOB, [1], [1], {
      blockNumber: 1_005,
      transactionHash: SALE_TX,
      transactionIndex: 3,
      logIndex: 8
    }),
    erc1155TransferSingleLog(MEMES, ALICE, CAROL, 1, 1, {
      blockNumber: 1_009,
      transactionHash: GIFT_TX,
      logIndex: 0
    })
  ];
}

function receiptOf(hash: string): ApplyReceipt | null {
  const logs = chainLogs().filter((log) => log.transactionHash === hash);
  if (!logs.length) return null;
  return {
    blockNumber: logs[0].blockNumber,
    blockHash: logs[0].blockHash,
    logs: logs.map((log) => ({
      address: log.address,
      data: log.data,
      topics: log.topics,
      index: log.logIndex,
      transactionIndex: log.transactionIndex,
      removed: false
    }))
  };
}

type Rpc = StateAuditApplyRpc & {
  getLogs: jest.Mock;
  getBlock: jest.Mock;
  getTransactionReceipt: jest.Mock;
};

function rpcWith(hashes: Record<number, string> = {}): Rpc {
  return {
    getBlock: jest.fn().mockImplementation(async (tag: number | string) => {
      if (tag === 'finalized') return block(5_000);
      if (typeof tag === 'string' && tag.startsWith('0x')) {
        // Block hashes from the fixture encode their number in the last 16 hex digits.
        const number = Number.parseInt(tag.slice(-16), 16);
        return block(number, tag);
      }
      return block(Number(tag), hashes[Number(tag)]);
    }),
    getLogs: jest.fn().mockImplementation(async () => chainLogs()),
    getTransactionReceipt: jest
      .fn()
      .mockImplementation(async (hash: string) => receiptOf(hash))
  };
}

function ledgerRow(
  transaction: string,
  blockNumber: number,
  from: string,
  to: string,
  tokenCount: number
) {
  return {
    created_at: new Date('2026-01-01T00:00:00Z'),
    transaction,
    block: blockNumber,
    transaction_date: new Date('2026-01-01T00:00:00Z'),
    from_address: from,
    to_address: to,
    contract: MEMES,
    token_id: 1,
    token_count: tokenCount,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

function ownerRow(wallet: string, balance: number) {
  return {
    wallet,
    contract: MEMES,
    token_id: 1,
    balance,
    block_reference: OWNERS_BLOCK
  };
}

const auditRequest: StateAuditRequest = {
  contract: 'memes',
  fromBlock: FROM_BLOCK,
  toBlock: TO_BLOCK,
  chainId: 1,
  wallets: [],
  out: null,
  format: 'json'
};

async function audit(
  overrides: Partial<StateAuditRequest> = {}
): Promise<StateAuditManifest> {
  return runStateAudit(
    { ...auditRequest, ...overrides },
    {
      rpc: rpcWith(),
      db: new StateAuditDb(() => sqlExecutor),
      chainId: 1
    }
  );
}

function applyRequest(
  manifest: StateAuditManifest,
  overrides: Partial<StateAuditApplyRequest> = {}
): StateAuditApplyRequest {
  return {
    manifestPath: '<in-memory>',
    planDigest: manifest.plan_digest,
    jobId: JOB_ID,
    live: true,
    maxManifestAgeHours: 168,
    ...overrides
  };
}

function depsWith(
  overrides: Partial<StateAuditApplyDeps> = {}
): StateAuditApplyDeps {
  return {
    rpc: rpcWith(),
    db: new StateAuditApplyDb(() => sqlExecutor),
    reconciliation: new TransferReconciliationDb(() => sqlExecutor),
    chainId: 1,
    applyEnabled: () => true,
    ...overrides
  };
}

/** Enqueuer that fails on the given call numbers (1-based) and delegates otherwise. */
function failingEnqueuer(failOnCalls: number[]): ReconciliationEnqueuer & {
  calls: number;
} {
  const real = new TransferReconciliationDb(() => sqlExecutor);
  const enqueuer = {
    calls: 0,
    async enqueue(
      wallets: string[],
      consumers: Parameters<ReconciliationEnqueuer['enqueue']>[1],
      ctx: Parameters<ReconciliationEnqueuer['enqueue']>[2]
    ) {
      enqueuer.calls += 1;
      if (failOnCalls.includes(enqueuer.calls)) {
        throw new Error(`injected enqueue failure on call ${enqueuer.calls}`);
      }
      await real.enqueue(wallets, consumers, ctx);
    }
  };
  return enqueuer;
}

/** Re-signs a deliberately edited manifest so only chain revalidation can catch it. */
function resign(manifest: StateAuditManifest): StateAuditManifest {
  return { ...manifest, plan_digest: computePlanDigest(manifest) };
}

async function insertLedgerRow(row: ReturnType<typeof ledgerRow>) {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `INSERT INTO ${TRANSACTIONS_TABLE} (${columns.join(', ')})
     VALUES (${columns.map((column) => `:${column}`).join(', ')})`,
    row
  );
}

async function ledgerRows() {
  return sqlExecutor.execute<{
    transaction: string;
    from_address: string;
    to_address: string;
    token_count: number;
    transaction_date: Date;
    eth_price_usd: number;
  }>(
    `SELECT transaction, from_address, to_address, token_count, transaction_date, eth_price_usd
     FROM ${TRANSACTIONS_TABLE} ORDER BY block, transaction, from_address, to_address, token_id`
  );
}

async function queueRows() {
  return sqlExecutor.execute<{ consumer: string; wallet: string }>(
    `SELECT consumer, wallet FROM ${TRANSFER_RECONCILIATIONS_TABLE} ORDER BY consumer, wallet`
  );
}

async function jobRows() {
  return sqlExecutor.execute<{
    job_id: string;
    plan_digest: string;
    state: string;
    next_index: number;
    applied_units: number;
    last_error: string | null;
  }>(
    `SELECT job_id, plan_digest, state, next_index, applied_units, last_error FROM ${STATE_AUDIT_JOBS_TABLE}`
  );
}

const DRIFTED_LEDGER = [
  ledgerRow(MINT_TX, 1_001, ZERO, ALICE, 5),
  // Historical ERC-1155 quantity recorded as 1 although the chain moved 2.
  ledgerRow(SALE_TX, 1_005, ALICE, BOB, 1),
  // A row with no chain counterpart.
  ledgerRow(BOGUS_TX, 1_007, BOB, DAVE, 1)
  // GIFT_TX is wholly missing from the ledger.
];

const EXPECTED_QUEUE = [
  { consumer: 'activity', wallet: ALICE },
  { consumer: 'activity', wallet: BOB },
  { consumer: 'activity', wallet: CAROL },
  { consumer: 'activity', wallet: DAVE },
  { consumer: 'owners', wallet: ALICE },
  { consumer: 'owners', wallet: BOB },
  { consumer: 'owners', wallet: CAROL },
  { consumer: 'owners', wallet: DAVE }
];

describeWithSeed(
  'state audit apply against a drifted ledger',
  [
    { table: TRANSACTIONS_TABLE, rows: DRIFTED_LEDGER },
    {
      table: NFT_OWNERS_TABLE,
      // Owners were built from the drifted ledger: Alice 4, Bob 0, Dave 1.
      rows: [ownerRow(ALICE, 4), ownerRow(BOB, 0), ownerRow(DAVE, 1)]
    },
    {
      table: ETH_PRICE_TABLE,
      rows: [
        {
          timestamp_ms: 0,
          date: new Date('2020-01-01T00:00:00Z'),
          usd_price: ETH_PRICE
        }
      ]
    }
  ],
  () => {
    it('plans three units in a dry run and writes nothing', async () => {
      const manifest = await audit();
      expect(manifest.status).toBe('differences_found');
      const original = sqlExecutor;
      const guard = new MutationGuard(original);
      setSqlExecutor(guard);
      try {
        const report = await runStateAuditApply(
          manifest,
          applyRequest(manifest, { live: false }),
          depsWith({
            db: new StateAuditApplyDb(() => guard),
            applyEnabled: () => false
          })
        );
        expect(report.outcome).toBe('planned');
        expect(report.mode).toBe('dry-run');
        expect(report.rejection).toBeNull();
        expect(report.job).toBeNull();
        expect(report.revalidation).toEqual({
          anchors: 'match',
          receipts_checked: 3,
          ledger_image: 'match',
          discrepancies: 'match'
        });
        expect(
          report.units.map((unit) => [
            unit.transaction,
            unit.outcome,
            unit.actions.map((action) => action.action),
            unit.wallets
          ])
        ).toEqual([
          [SALE_TX, 'planned', ['update_token_count'], [ALICE, BOB]],
          [GIFT_TX, 'planned', ['insert'], [ALICE, CAROL]],
          [BOGUS_TX, 'planned', ['delete'], [BOB, DAVE]]
        ]);
        expect(report.summary).toEqual({
          total_units: 3,
          applied_units: 0,
          owner_balance_mismatches_deferred: 4,
          value_enrichment: 'discovery_defaults'
        });
        expect(report.tdh.affected_wallets).toEqual([ALICE, BOB, CAROL, DAVE]);
        expect(guard.statements.length).toBeGreaterThan(0);
      } finally {
        setSqlExecutor(original);
      }
      expect((await ledgerRows()).map((row) => row.token_count)).toEqual([
        5, 1, 1
      ]);
      expect(await queueRows()).toEqual([]);
      expect(await jobRows()).toEqual([]);
    });

    it('refuses to write while the apply gate is off', async () => {
      const manifest = await audit();
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ applyEnabled: () => false })
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('apply_disabled');
      expect(await jobRows()).toEqual([]);
      expect(await queueRows()).toEqual([]);
    });

    it('rejects a stale chain anchor and writes nothing', async () => {
      const manifest = await audit();
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ rpc: rpcWith({ [TO_BLOCK]: `0x${'c'.repeat(64)}` }) })
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('stale_chain');
      expect(report.revalidation.anchors).toBe('not_checked');
      expect((await ledgerRows()).map((row) => row.token_count)).toEqual([
        5, 1, 1
      ]);
      expect(await queueRows()).toEqual([]);
      expect(await jobRows()).toEqual([]);
    });

    it('rejects a moved transaction receipt as a stale chain', async () => {
      const manifest = await audit();
      const rpc = rpcWith();
      rpc.getTransactionReceipt.mockImplementation(async (hash: string) => {
        const receipt = receiptOf(hash);
        return receipt && hash === GIFT_TX
          ? { ...receipt, blockHash: `0x${'d'.repeat(64)}` }
          : receipt;
      });
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ rpc })
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('stale_chain');
      expect(report.rejection?.detail).toContain(GIFT_TX);
      expect(await jobRows()).toEqual([]);
      expect(await queueRows()).toEqual([]);
    });

    it('rejects a database that changed after the manifest was produced', async () => {
      const manifest = await audit();
      await sqlExecutor.execute(
        `UPDATE ${TRANSACTIONS_TABLE} SET token_count = 4 WHERE transaction = :tx`,
        { tx: MINT_TX }
      );
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith()
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('stale_database');
      expect(report.revalidation.ledger_image).toBe('mismatch');
      expect((await ledgerRows()).map((row) => row.token_count)).toEqual([
        4, 1, 1
      ]);
      expect(await queueRows()).toEqual([]);
      expect(await jobRows()).toEqual([]);
    });

    it('rejects an edited manifest presented with the reviewed digest', async () => {
      const manifest = await audit();
      const tampered: StateAuditManifest = {
        ...manifest,
        discrepancies: manifest.discrepancies.map((entry) =>
          entry.type === 'token_count_mismatch'
            ? {
                ...entry,
                expected_row: { ...entry.expected_row, token_count: 9 }
              }
            : entry
        )
      };
      const report = await runStateAuditApply(
        tampered,
        applyRequest(manifest),
        depsWith()
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('plan_digest_mismatch');
      expect(report.revalidation.anchors).toBe('not_checked');
      expect(await jobRows()).toEqual([]);
    });

    it('rejects a re-signed manifest whose discrepancies the receipts do not reproduce', async () => {
      const manifest = await audit();
      const edited = resign({
        ...manifest,
        discrepancies: manifest.discrepancies.map((entry) =>
          entry.type === 'token_count_mismatch'
            ? {
                ...entry,
                expected_row: { ...entry.expected_row, token_count: 9 }
              }
            : entry
        )
      });
      const report = await runStateAuditApply(
        edited,
        applyRequest(edited),
        depsWith()
      );
      expect(report.outcome).toBe('rejected');
      expect(report.rejection?.code).toBe('plan_mismatch');
      expect(report.revalidation.receipts_checked).toBe(3);
      expect(await jobRows()).toEqual([]);
      expect((await ledgerRows()).map((row) => row.token_count)).toEqual([
        5, 1, 1
      ]);
    });

    it('rejects an unsupported contract and an unsupported discrepancy explicitly', async () => {
      const manifest = await audit();
      const foreign = resign({
        ...manifest,
        contract: {
          ...manifest.contract,
          address: `0x${'f'.repeat(40)}`,
          supported: false
        }
      });
      const unsupportedContract = await runStateAuditApply(
        foreign,
        applyRequest(foreign),
        depsWith()
      );
      expect(unsupportedContract.rejection?.code).toBe('unsupported_contract');

      const duplicate: Discrepancy = {
        type: 'unexpected_row',
        transaction: SALE_TX,
        detail: 'duplicate_normalized_key',
        stored_row: {
          transaction: SALE_TX,
          block: 1_005,
          from_address: ALICE,
          to_address: BOB,
          contract: MEMES,
          token_id: '1',
          token_count: 1
        },
        expected_row: null
      };
      const withDuplicate = resign({
        ...manifest,
        discrepancies: manifest.discrepancies.concat([duplicate])
      });
      const unsupportedDiscrepancy = await runStateAuditApply(
        withDuplicate,
        applyRequest(withDuplicate),
        depsWith()
      );
      expect(unsupportedDiscrepancy.outcome).toBe('rejected');
      expect(unsupportedDiscrepancy.rejection?.code).toBe(
        'unsupported_discrepancy'
      );
      expect(await jobRows()).toEqual([]);
      expect(await queueRows()).toEqual([]);
    });

    it('rolls back the ledger correction when the enqueue of the same unit fails', async () => {
      const manifest = await audit();
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ reconciliation: failingEnqueuer([1]) })
      );
      expect(report.outcome).toBe('failed');
      expect(report.rejection?.code).toBe('database_error');
      expect(report.units.map((unit) => unit.outcome)).toEqual([
        'failed',
        'not_reached',
        'not_reached'
      ]);
      expect(report.units[0].error).toContain('injected enqueue failure');
      expect((await ledgerRows()).map((row) => row.token_count)).toEqual([
        5, 1, 1
      ]);
      expect(await queueRows()).toEqual([]);
      expect(await jobRows()).toMatchObject([
        {
          job_id: JOB_ID,
          plan_digest: manifest.plan_digest,
          state: 'pending',
          next_index: 0,
          applied_units: 0
        }
      ]);
      expect((await jobRows())[0].last_error).toContain(
        'injected enqueue failure'
      );
    });

    it('resumes after a failure between units without repeating the first unit', async () => {
      const manifest = await audit();
      const first = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ reconciliation: failingEnqueuer([2]) })
      );
      expect(first.outcome).toBe('failed');
      expect(first.units.map((unit) => unit.outcome)).toEqual([
        'applied',
        'failed',
        'not_reached'
      ]);
      expect(first.enqueued_wallets).toEqual([ALICE, BOB]);
      expect(await ledgerRows()).toMatchObject([
        { transaction: MINT_TX, token_count: 5 },
        { transaction: SALE_TX, token_count: 2 },
        { transaction: BOGUS_TX, token_count: 1 }
      ]);
      expect(await queueRows()).toEqual([
        { consumer: 'activity', wallet: ALICE },
        { consumer: 'activity', wallet: BOB },
        { consumer: 'owners', wallet: ALICE },
        { consumer: 'owners', wallet: BOB }
      ]);
      expect(await jobRows()).toMatchObject([
        { state: 'pending', next_index: 1, applied_units: 1 }
      ]);

      const enqueuer = failingEnqueuer([]);
      const second = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ reconciliation: enqueuer })
      );
      expect(second.outcome).toBe('applied');
      expect(second.rejection).toBeNull();
      expect(second.units.map((unit) => unit.outcome)).toEqual([
        'previously_applied',
        'applied',
        'applied'
      ]);
      expect(enqueuer.calls).toBe(2);
      expect(second.enqueued_wallets).toEqual([ALICE, BOB, CAROL, DAVE]);
      expect(second.wallets_not_enqueued).toEqual([]);
      expect(second.job).toMatchObject({
        job_id: JOB_ID,
        state: 'applied',
        next_index: 3,
        applied_units: 3,
        last_error: null,
        created: false
      });

      const rows = await ledgerRows();
      expect(rows).toMatchObject([
        { transaction: MINT_TX, token_count: 5 },
        { transaction: SALE_TX, token_count: 2 },
        {
          transaction: GIFT_TX,
          from_address: ALICE,
          to_address: CAROL,
          token_count: 1,
          eth_price_usd: ETH_PRICE
        }
      ]);
      expect(new Date(rows[2].transaction_date).getTime()).toBe(
        (BASE_TIMESTAMP + 1_009) * 1000
      );
      // Exactly one request per (consumer, wallet): the table's unique key.
      expect(await queueRows()).toEqual(EXPECTED_QUEUE);
      expect(await jobRows()).toMatchObject([
        { state: 'applied', next_index: 3, applied_units: 3, last_error: null }
      ]);
    });

    it('applies all units, treats a repeat as already applied and leaves the ledger part of a fresh audit clean', async () => {
      const manifest = await audit();
      const applied = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith()
      );
      expect(applied.outcome).toBe('applied');
      expect(applied.job?.created).toBe(true);
      expect(await queueRows()).toEqual(EXPECTED_QUEUE);

      const enqueuer = failingEnqueuer([1]);
      const repeat = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith({ reconciliation: enqueuer })
      );
      expect(repeat.outcome).toBe('already_applied');
      expect(repeat.rejection).toBeNull();
      expect(repeat.units).toEqual([]);
      expect(enqueuer.calls).toBe(0);
      expect(repeat.revalidation.anchors).toBe('not_checked');
      expect(await queueRows()).toEqual(EXPECTED_QUEUE);
      expect((await ledgerRows()).map((row) => row.transaction)).toEqual([
        MINT_TX,
        SALE_TX,
        GIFT_TX
      ]);
      expect(await jobRows()).toMatchObject([
        { state: 'applied', applied_units: 3 }
      ]);

      // The same job id must not be reusable for a different plan.
      const differentPlan = resign({
        ...manifest,
        discrepancies: manifest.discrepancies.slice(0, 1)
      });
      const rebound = await runStateAuditApply(
        differentPlan,
        applyRequest(differentPlan),
        depsWith()
      );
      expect(rebound.rejection?.code).toBe('job_digest_mismatch');

      // Ledger part of a fresh read-only audit is clean. The owners part still
      // differs because the queue consumers have not run; that is expected.
      // The clean ledger yields no affected wallets, so the derived owner
      // check needs the explicit wallet list to be evaluated at all.
      const after = await audit({ wallets: [ALICE, BOB, CAROL, DAVE] });
      expect(after.inconclusive_reasons).toEqual([]);
      expect(after.summary).toMatchObject({
        missing_transaction: 0,
        missing_edge: 0,
        token_count_mismatch: 0,
        token_id_mismatch: 0,
        unexpected_row: 0
      });
      expect(after.ledger_before_image.row_count).toBe(3);
      expect(
        after.discrepancies.every((d) => d.type === 'owner_balance_mismatch')
      ).toBe(true);
      expect(after.derived_checks.owner_balance.status).toBe('evaluated');
      expect(after.summary.owner_balance_mismatch).toBe(4);
      expect(after.status).toBe('differences_found');
    });

    it('marks the job failed when a unit finds rows changed under it', async () => {
      const manifest = await audit();
      const deps = depsWith();
      const lock = deps.db.lockLedgerRowsOfTransaction.bind(deps.db);
      let mutated = false;
      jest
        .spyOn(deps.db, 'lockLedgerRowsOfTransaction')
        .mockImplementation(async (contract, transaction, ctx) => {
          if (!mutated && transaction === GIFT_TX) {
            // A concurrent writer lands the gift just before unit 1 locks it.
            mutated = true;
            await insertLedgerRow(ledgerRow(GIFT_TX, 1_009, ALICE, CAROL, 1));
          }
          return lock(contract, transaction, ctx);
        });
      const report = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        deps
      );
      expect(report.outcome).toBe('failed');
      expect(report.rejection?.code).toBe('stale_database');
      expect(report.units.map((unit) => unit.outcome)).toEqual([
        'applied',
        'stale',
        'not_reached'
      ]);
      expect(await jobRows()).toMatchObject([
        { state: 'failed', next_index: 1, applied_units: 1 }
      ]);
      const again = await runStateAuditApply(
        manifest,
        applyRequest(manifest),
        depsWith()
      );
      expect(again.rejection?.code).toBe('job_failed');
    });
  }
);
