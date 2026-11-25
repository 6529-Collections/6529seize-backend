import 'reflect-metadata';
import {
  DISTRIBUTION_TABLE,
  DROP_FORGE_JOBS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE,
  MEMES_CONTRACT,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { resetAllowlistRows } from '@/api/subscriptions/api.subscriptions.allowlist';
import { dropForgePreparationRepository } from '@/drop-forge/drop-forge.preparation.repository';
import { launchId } from '@/drop-forge/drop-forge.repository';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import type { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { mintCard } from './mint-log-parts';
import type { MintRecordLogEntry, MintRecordLogPort } from './mint-log-ports';
import {
  loggedPreparationReset,
  loggedPreparationWrite
} from './mint-log-preparation';
import { MintLogRecorder, MintWriteSpec } from './mint-log-recorder';
import type { MintLogEntryBody, MintLogKind } from './mint-log.types';

const CONTRACT = MEMES_CONTRACT.toLowerCase();
const CARD_ID = 100;
const CARD = mintCard(CONTRACT, CARD_ID);
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const AT = new Date('2026-11-20T00:00:00Z');

/** Long enough for a started transaction to reach the lock it waits on. */
const SETTLE_MS = 400;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const subscription = (n: number) => ({
  consolidation_key: W(n),
  contract: CONTRACT,
  token_id: CARD_ID,
  subscribed_count: 1,
  airdrop_address: W(n),
  balance: 1,
  subscribed_at: '2026-11-20',
  phase: 'Phase 1',
  phase_subscriptions: 1,
  phase_position: n,
  redeemed_count: 0,
  created_at: AT,
  updated_at: AT
});

/** One distribution row for the card, on the given transaction or alone. */
async function insertDistribution(
  wallet: string,
  phase: string,
  ctx: RequestContext = {}
): Promise<void> {
  await sqlExecutor.execute(
    `insert into ${DISTRIBUTION_TABLE}
       (card_id, contract, phase, wallet, wallet_tdh, wallet_balance,
        wallet_unique_balance, count, count_airdrop, count_allowlist)
     values (:card, :contract, :phase, :wallet, 0, 0, 0, 1, 0, 1)`,
    { card: CARD_ID, contract: CONTRACT, phase, wallet },
    ctx.connection ? { wrappedConnection: ctx.connection } : undefined
  );
}

async function distributionWallets(): Promise<string[]> {
  return (
    await sqlExecutor.execute<{ wallet: string }>(
      `select wallet from ${DISTRIBUTION_TABLE}
       where contract = :contract and card_id = :card order by wallet`,
      { contract: CONTRACT, card: CARD_ID }
    )
  ).map((row) => row.wallet);
}

describeWithSeed(
  'mint log writes under the Drop Forge preparation',
  [
    {
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [subscription(1), subscription(2)]
    }
  ],
  () => {
    const entries: MintLogEntryBody[] = [];
    const log: MintRecordLogPort = {
      append: async (queued: readonly MintRecordLogEntry[]) => {
        for (const entry of queued) {
          if (entry.t === 'entry') {
            entries.push(entry.body as unknown as MintLogEntryBody);
          }
        }
      }
    };
    const recorder = new MintLogRecorder(
      {
        isMintLogShadowEnabled: () => true,
        isMintLogPrimaryEnabled: () => false,
        isMintLogReplayCheckEnabled: () => false
      },
      () => ({ records: null, log })
    );
    const spec = <T>(kind: MintLogKind): MintWriteSpec<T> => ({
      kind,
      card: CARD,
      actor: { type: 'admin', wallet: W(9), authority: 'test' },
      intent: { route: kind, params: {}, body: null }
    });
    /** A phase split's write, as the route runs it, with its own row. */
    const preparedWrite = (
      wallet: string,
      before: () => Promise<void> = async () => undefined
    ) =>
      loggedPreparationWrite({
        spec: spec<void>('dist.phase'),
        contract: CONTRACT,
        claim: CARD_ID,
        write: async (ctx) => {
          await insertDistribution(wallet, 'Phase 1', ctx);
          await before();
        },
        start: 'MANUAL',
        recorder
      });
    /** Another logged write to the card that takes no Drop Forge lock. */
    const plainWrite = (
      wallet: string,
      before: () => Promise<void> = async () => undefined
    ) =>
      recorder.write(spec<void>('dist.airdrops'), async () => {
        await insertDistribution(wallet, 'Airdrop', {});
        await before();
      });
    /** Drop Forge's worker holding the preparation, writing unlogged. */
    const workerHolding = (wallet: string, release: Promise<void>) =>
      dropForgePreparationRepository.run(
        CONTRACT,
        CARD_ID,
        async (_, ctx) => {
          await insertDistribution(wallet, 'Worker', ctx);
          await release;
        },
        {}
      );

    beforeEach(() => {
      entries.length = 0;
    });

    it('lets a refusal from a frozen launch through, with no entry and no row', async () => {
      await sqlExecutor.execute(
        `insert into ${DROP_FORGE_LAUNCHES_TABLE}
           (id, revision, state, error, data, updated_at, report_pending)
         values (:id, 1, 'ARMED', null, '{}', 1, false)`,
        { id: launchId(1, CONTRACT, CARD_ID) }
      );
      const write = jest.fn();

      await expect(
        loggedPreparationWrite({
          spec: spec<void>('dist.phase'),
          contract: CONTRACT,
          claim: CARD_ID,
          write,
          start: 'MANUAL',
          recorder
        })
      ).rejects.toBeInstanceOf(LaunchSafetyError);
      expect(write).not.toHaveBeenCalled();
      expect(entries).toEqual([]);
    });

    it("lets the writer's own refusal through, and rolls its rows back with no entry", async () => {
      await expect(
        loggedPreparationWrite({
          spec: spec<void>('dist.phase'),
          contract: CONTRACT,
          claim: CARD_ID,
          write: async (ctx) => {
            await insertDistribution(W(2), 'Phase 1', ctx);
            throw new LaunchSafetyError('EMMA inputs changed');
          },
          start: 'MANUAL',
          recorder
        })
      ).rejects.toThrow('EMMA inputs changed');
      expect(entries).toEqual([]);
      expect(await distributionWallets()).toEqual([]);
    });

    it('answers a reset 409 while a job finishes a step, before the log, with no entry', async () => {
      await sqlExecutor.execute(
        `insert into ${DROP_FORGE_JOBS_TABLE}
           (id, contract, claim_id, kind, status, updated_at)
         values ('job-1', :contract, :claim, 'FINALIZE', 'PROCESSING', 1)`,
        { contract: CONTRACT, claim: CARD_ID }
      );
      const held = gate();
      const locked = gate();
      const job = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `select id from ${DROP_FORGE_JOBS_TABLE} where id = 'job-1' for update`,
            undefined,
            { wrappedConnection: connection }
          );
          locked.open();
          await held.opened;
        }
      );
      await locked.opened;

      try {
        await expect(
          loggedPreparationReset({
            spec: spec<void>('dist.reset'),
            contract: CONTRACT,
            claim: CARD_ID,
            reset: (ctx) => resetAllowlistRows(CONTRACT, CARD_ID, ctx),
            recorder
          })
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        held.open();
        await job;
      }
      expect(entries).toEqual([]);
      const [phases] = await sqlExecutor.execute<{ phased: number }>(
        `select count(*) as phased from ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
         where contract = :contract and token_id = :card and phase is not null`,
        { contract: CONTRACT, card: CARD_ID }
      );
      expect(Number(phases.phased)).toBe(2);
    });

    it('logs a reset inside the preparation, rows and entry together', async () => {
      await insertDistribution(W(1), 'Phase 1');

      await loggedPreparationReset({
        spec: spec<void>('dist.reset'),
        contract: CONTRACT,
        claim: CARD_ID,
        reset: (ctx) => resetAllowlistRows(CONTRACT, CARD_ID, ctx),
        recorder
      });

      expect(entries.map((entry) => entry.kind)).toEqual(['dist.reset']);
      expect(await distributionWallets()).toEqual([]);
    });

    it('completes a preparation write and another logged write together, the preparation first', async () => {
      const held = gate();
      const prepared = preparedWrite(W(2), () => held.opened);
      await settle();
      const plain = plainWrite(W(3));
      await settle();
      held.open();

      await Promise.all([prepared, plain]);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.phase',
        'dist.airdrops'
      ]);
      expect(await distributionWallets()).toEqual([W(2), W(3)]);
    });

    it('completes a preparation write and another logged write together, the other first', async () => {
      const held = gate();
      const plain = plainWrite(W(3), () => held.opened);
      await settle();
      const prepared = preparedWrite(W(2));
      await settle();
      held.open();

      await Promise.all([plain, prepared]);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'dist.phase'
      ]);
      expect(await distributionWallets()).toEqual([W(2), W(3)]);
    });

    it("doesn't hold other logged writes behind a preparation the worker holds", async () => {
      const released = gate();
      const worker = workerHolding(W(1), released.opened);
      await settle();
      const prepared = preparedWrite(W(2));
      await settle();

      // The preparation write waits for the worker; the head stays free.
      await plainWrite(W(3));
      expect(entries.map((entry) => entry.kind)).toEqual(['dist.airdrops']);

      released.open();
      await Promise.all([worker, prepared]);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'dist.phase'
      ]);
    });

    it('reads the entry\'s "before" rows once the preparation is held, so a worker\'s rows stay out of it', async () => {
      const released = gate();
      const worker = workerHolding(W(1), released.opened);
      await settle();
      const prepared = preparedWrite(W(2));
      await settle();
      released.open();
      await Promise.all([worker, prepared]);

      const [entry] = entries;
      expect(entry.kind).toBe('dist.phase');
      expect(
        (entry.effects.distribution?.upsert ?? []).map((row) => row.wallet)
      ).toEqual([W(2)]);
      expect(await distributionWallets()).toEqual([W(1), W(2)]);
    });
  }
);
