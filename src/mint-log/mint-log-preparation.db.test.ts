import 'reflect-metadata';
import {
  DISTRIBUTION_TABLE,
  DROP_FORGE_JOBS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_PREPARATIONS_TABLE,
  MEMES_CONTRACT,
  MINT_LOG_HEAD_TABLE,
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
import {
  InvalidSignedRecordException,
  MintLogRecorder,
  MintWriteSpec
} from './mint-log-recorder';
import type { MintLogEntryBody, MintLogKind } from './mint-log.types';

const CONTRACT = MEMES_CONTRACT.toLowerCase();
const CARD_ID = 100;
const CARD = mintCard(CONTRACT, CARD_ID);
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const AT = new Date('2026-11-20T00:00:00Z');

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Where a writer signals that it holds its locks, and waits to go on. */
interface Hold {
  readonly reached: () => void;
  readonly until: Promise<void>;
}
const NO_HOLD: Hold = { reached: () => undefined, until: Promise.resolve() };

function hold() {
  const reached = gate();
  const release = gate();
  const held: Hold = { reached: reached.open, until: release.opened };
  return { held, reached: reached.opened, release: release.open };
}

/**
 * Fails a step that should not wait, so a test's finally still releases the
 * transactions it holds instead of Jest abandoning the test mid-wait.
 */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} still waiting after 10 s`)),
        10_000
      );
    })
  ]).finally(() => clearTimeout(timer));
}

/** The statement a write blocks on when another holds that lock. */
const WAITS_ON_PREPARATION = `INSERT INTO ${DROP_FORGE_PREPARATIONS_TABLE}%`;
const WAITS_ON_HEAD = `insert into ${MINT_LOG_HEAD_TABLE}%`;

/**
 * Waits until another session is blocked in the statement that takes the
 * given lock (seen still running in two polls in a row), so a test knows
 * the order its transactions reached their locks in rather than guessing.
 * Only this test's database counts; every test connection uses the same
 * user, so the processlist shows them.
 */
async function waitingOn(statement: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let seen = 0;
  for (;;) {
    const [row] = await sqlExecutor.execute<{ waiting: number | string }>(
      `select count(*) as waiting from information_schema.processlist
       where command = 'Query' and info like :statement
         and db = database() and id <> connection_id()`,
      { statement }
    );
    seen = Number(row.waiting) > 0 ? seen + 1 : 0;
    if (seen >= 2) return;
    if (Date.now() > deadline) {
      throw new Error(`No session waiting in ${statement} after 20 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

/** The card's Drop Forge preparation mode, or 'none' with no row. */
async function preparationMode(): Promise<string> {
  const [row] = await sqlExecutor.execute<{ mode: string | null }>(
    `select mode from ${DROP_FORGE_PREPARATIONS_TABLE} where id = :id`,
    { id: `${CONTRACT}:${CARD_ID}` }
  );
  return row ? (row.mode ?? 'null') : 'none';
}

/** How many mint log heads an entry has moved. */
async function advancedHeads(): Promise<number> {
  const [row] = await sqlExecutor.execute<{ n: number | string }>(
    `select count(*) as n from ${MINT_LOG_HEAD_TABLE} where seq >= 0`
  );
  return Number(row.n);
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
    const recorderWith = (args: {
      readonly primary?: boolean;
      readonly replay?: boolean;
      readonly failingLog?: boolean;
    }) =>
      new MintLogRecorder(
        {
          isMintLogShadowEnabled: () => true,
          isMintLogPrimaryEnabled: () => args.primary === true,
          isMintLogReplayCheckEnabled: () => args.replay === true
        },
        () => ({
          records: null,
          log: args.failingLog
            ? {
                append: async () => {
                  throw new Error('the record log is down');
                }
              }
            : log
        })
      );
    const recorder = recorderWith({});
    const spec = <T>(kind: MintLogKind): MintWriteSpec<T> => ({
      kind,
      card: CARD,
      actor: { type: 'admin', wallet: W(9), authority: 'test' },
      intent: { route: kind, params: {}, body: null }
    });
    /** A phase split's write, as the route runs it, with its own row. */
    const preparedWrite = (
      wallet: string,
      args: {
        readonly held?: Hold;
        readonly recorder?: MintLogRecorder;
        readonly spec?: MintWriteSpec<void>;
      } = {}
    ) =>
      loggedPreparationWrite({
        spec: args.spec ?? spec<void>('dist.phase'),
        contract: CONTRACT,
        claim: CARD_ID,
        write: async (ctx) => {
          await insertDistribution(wallet, 'Phase 1', ctx);
          (args.held ?? NO_HOLD).reached();
          await (args.held ?? NO_HOLD).until;
        },
        start: 'MANUAL',
        recorder: args.recorder ?? recorder
      });
    /** Another logged write to the card that takes no Drop Forge lock. */
    const plainWrite = (wallet: string, held: Hold = NO_HOLD) =>
      recorder.write(spec<void>('dist.airdrops'), async () => {
        await insertDistribution(wallet, 'Airdrop', {});
        held.reached();
        await held.until;
      });
    /** Drop Forge's worker holding the preparation, writing unlogged. */
    const workerHolding = (wallet: string, held: Hold) =>
      dropForgePreparationRepository.run(
        CONTRACT,
        CARD_ID,
        async (_, ctx) => {
          await insertDistribution(wallet, 'Worker', ctx);
          held.reached();
          await held.until;
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
      const job_ = hold();
      const job = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `select id from ${DROP_FORGE_JOBS_TABLE} where id = 'job-1' for update`,
            undefined,
            { wrappedConnection: connection }
          );
          job_.held.reached();
          await job_.held.until;
        }
      );
      await job_.reached;

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
        job_.release();
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
      const first = hold();
      const prepared = preparedWrite(W(2), { held: first.held });
      let plain: Promise<void> | undefined;
      try {
        // It holds the preparation and the head; the other write waits.
        await first.reached;
        plain = plainWrite(W(3));
        await waitingOn(WAITS_ON_HEAD);
      } finally {
        first.release();
      }

      await Promise.all([prepared, plain]);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.phase',
        'dist.airdrops'
      ]);
      expect(await distributionWallets()).toEqual([W(2), W(3)]);
    });

    it('completes a preparation write and another logged write together, the other first', async () => {
      const first = hold();
      const plain = plainWrite(W(3), first.held);
      let prepared: Promise<void> | undefined;
      try {
        // It holds the head; the preparation write takes the preparation
        // and waits for the head.
        await first.reached;
        prepared = preparedWrite(W(2));
        await waitingOn(WAITS_ON_HEAD);
      } finally {
        first.release();
      }

      await Promise.all([plain, prepared]);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'dist.phase'
      ]);
      expect(await distributionWallets()).toEqual([W(2), W(3)]);
    });

    it("doesn't hold other logged writes behind a preparation the worker holds", async () => {
      const worker_ = hold();
      const worker = workerHolding(W(1), worker_.held);
      let prepared: Promise<void> | undefined;
      let whileHeld: string[] = [];
      try {
        await worker_.reached;
        prepared = preparedWrite(W(2));
        await waitingOn(WAITS_ON_PREPARATION);
        // The preparation write waits for the worker; the head stays free.
        await within(plainWrite(W(3)), 'the other logged write');
        whileHeld = entries.map((entry) => entry.kind);
      } finally {
        worker_.release();
      }
      await Promise.all([worker, prepared]);

      expect(whileHeld).toEqual(['dist.airdrops']);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'dist.phase'
      ]);
    });

    it('reads the entry\'s "before" rows once the preparation is held, so a worker\'s rows stay out of it', async () => {
      const worker_ = hold();
      const worker = workerHolding(W(1), worker_.held);
      let prepared: Promise<void> | undefined;
      try {
        await worker_.reached;
        // The write waits for the preparation before it reads anything.
        prepared = preparedWrite(W(2));
        await waitingOn(WAITS_ON_PREPARATION);
      } finally {
        worker_.release();
      }
      await Promise.all([worker, prepared]);

      const [entry] = entries;
      expect(entry.kind).toBe('dist.phase');
      expect(
        (entry.effects.distribution?.upsert ?? []).map((row) => row.wallet)
      ).toEqual([W(2)]);
      expect(await distributionWallets()).toEqual([W(1), W(2)]);
    });

    it('keeps the write and its preparation in shadow mode when the log fails, with no entry and no head', async () => {
      await preparedWrite(W(2), {
        recorder: recorderWith({ failingLog: true })
      });

      expect(await distributionWallets()).toEqual([W(2)]);
      expect(await preparationMode()).toBe('MANUAL');
      expect(entries).toEqual([]);
      expect(await advancedHeads()).toBe(0);
    });

    it('rolls the write and its preparation back in primary mode when the record is missing', async () => {
      await expect(
        preparedWrite(W(2), { recorder: recorderWith({ primary: true }) })
      ).rejects.toBeInstanceOf(InvalidSignedRecordException);

      expect(await distributionWallets()).toEqual([]);
      expect(await preparationMode()).toBe('none');
      expect(entries).toEqual([]);
    });

    it('rolls the write and its preparation back in primary mode when the log fails', async () => {
      await expect(
        preparedWrite(W(2), {
          recorder: recorderWith({ primary: true, failingLog: true }),
          spec: {
            ...spec<void>('dist.phase'),
            actor: { type: 'service', wallet: null, authority: 'test' }
          }
        })
      ).rejects.toThrow('the record log is down');

      expect(await distributionWallets()).toEqual([]);
      expect(await preparationMode()).toBe('none');
      expect(await advancedHeads()).toBe(0);
    });

    it('replays the entry inside the preparation when the replay check is on', async () => {
      await insertDistribution(W(1), 'Airdrop');

      await preparedWrite(W(2), { recorder: recorderWith({ replay: true }) });

      const [entry] = entries;
      expect(entry.checks.replay).toBe('match');
      expect(entry.checks.replay_mismatches).toEqual([]);
      expect(await distributionWallets()).toEqual([W(1), W(2)]);
    });
  }
);
