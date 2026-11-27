// The routers build their auth middleware on import; the endpoints the
// rebuild test reads are public, so authentication passes through.
jest.mock('@/api/auth/auth', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    ...jest.requireActual('@/api/auth/auth'),
    needsAuthenticatedUser: pass,
    maybeAuthenticatedUser: pass
  };
});

import 'reflect-metadata';
import distributionPhotosRoutes from '@/api/distribution-photos/api.distribution_photos.routes';
import distributionsRoutes from '@/api/distributions/api.distributions.routes';
import mintingClaimsRoutes from '@/api/minting-claims/api.minting-claims.routes';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  DROP_FORGE_JOBS_TABLE,
  MEME_CARD_DROP_MAPPINGS_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIM_ACTIONS_TABLE,
  MINTING_CLAIMS_TABLE,
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE,
  MINT_LOG_HEAD_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
} from '@/constants';
import { populateDistribution } from '@/api/distributions/api.distributions.service';
import { mintingClaimActionsDb } from '@/api/minting-claims/minting-claim-actions.db';
import { splitAllowlistResults } from '@/api/subscriptions/api.subscriptions.allowlist';
import { mirrorCompletion } from '@/drop-forge/drop-forge.completion';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  finalizeDistribution,
  prepareDistributionPhase
} from '@/drop-forge/drop-forge.preparation';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord, LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import type { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Logger } from '@/logging';
import * as priorityAlerts from '@/priority-alerts.context';
import {
  dropForgePhaseSpec,
  HELD_FLAG_LOCK_WAIT_SECONDS,
  HELD_FLAG_MIN_LOCK_WAIT_SECONDS,
  withDropForgeClaimActions,
  writeDropForgeClaimAction
} from './mint-log-drop-forge';
import { allOk, apiAnswers } from './mint-log-api-answers.test-utils';
import { mintStateReader } from './mint-log-capture';
import { differingParts } from './mint-log-diff';
import type { MintContentPort } from './mint-log-genesis';
import type { MintLogHeadDb } from './mint-log-head.db';
import { mintCard } from './mint-log-parts';
import { loggedPreparationWrite } from './mint-log-preparation';
import { MintLogRebuilder } from './mint-log-rebuild';
import { mintLogRecorder, MintWriteSpec } from './mint-log-recorder';
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

/** Fails a step that should not wait, so a finally still releases. */
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

/** Waits until another session is blocked in the given statement. */
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
const WAITS_ON_HEAD = 'insert into mint_log_head%';
const OTHER_CARD = 101;

const subscription = (n: number) => ({
  consolidation_key: W(n),
  contract: CONTRACT,
  token_id: CARD_ID,
  subscribed_count: 1,
  airdrop_address: W(n),
  balance: 1,
  subscribed_at: '2026-11-20',
  phase: null,
  phase_subscriptions: -1,
  phase_position: -1,
  redeemed_count: 0,
  created_at: AT,
  updated_at: AT
});

const phaseResult = (n: number, amount: number) => ({
  id: `r${n}`,
  wallet: W(n),
  phaseId: 'p',
  allowlistId: 'a',
  phaseComponentId: 'c',
  amount
});

/** The mint log's entries, in the order they were queued. */
async function entries(): Promise<MintLogEntryBody[]> {
  const rows = await sqlExecutor.execute<{ entry: string }>(
    `select entry from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
     where lane = 'mint' order by id`
  );
  return rows
    .map((row) => JSON.parse(row.entry))
    .filter((entry) => entry.t === 'entry')
    .map((entry) => entry.body as MintLogEntryBody);
}

/** A count, on the pool or inside the given transaction. */
async function count(sql: string, ctx: RequestContext = {}): Promise<number> {
  const [row] = await sqlExecutor.execute<{ n: number | string }>(
    sql,
    undefined,
    { wrappedConnection: ctx.connection }
  );
  return Number(row.n);
}

/** Drop Forge's background step for phase 1, with frozen EMMA results. */
function workerPhase(
  ctx: RequestContext,
  rows: ReturnType<typeof phaseResult>[]
) {
  return prepareDistributionPhase(
    CONTRACT,
    CARD_ID,
    'plan-1',
    'phase-1',
    '',
    ctx,
    { name: 'Phase 1', rows }
  );
}

/**
 * An admin's phase split, as the route logs it. On the job's card while a
 * job is pending Drop Forge refuses it, so the tests that run both at once
 * use another card: the mint log's head is what they share.
 */
function adminPhase(
  rows: ReturnType<typeof phaseResult>[],
  held?: { reached: () => void; until: Promise<void> },
  cardId = CARD_ID
) {
  const spec: MintWriteSpec<void> = {
    kind: 'dist.phase',
    card: mintCard(CONTRACT, cardId),
    actor: { type: 'admin', wallet: W(9), authority: 'test' },
    intent: { route: 'dist.phase', params: {}, body: null }
  };
  return loggedPreparationWrite({
    spec,
    contract: CONTRACT,
    claim: cardId,
    write: async (ctx) => {
      const split = await splitAllowlistResults(
        CONTRACT,
        cardId,
        'Phase 1',
        rows,
        ctx
      );
      await populateDistribution(CONTRACT, cardId, 'Phase 1', split, ctx);
      held?.reached();
      await held?.until;
    },
    start: 'MANUAL'
  });
}

/** Another logged write to the card that takes no Drop Forge lock. */
function plainWrite(kind: MintLogKind = 'dist.airdrops') {
  return mintLogRecorder.write(
    {
      kind,
      card: CARD,
      actor: { type: 'admin', wallet: W(9), authority: 'test' },
      intent: { route: kind, params: {}, body: null }
    },
    async () => {
      await sqlExecutor.execute(
        `insert into ${DISTRIBUTION_TABLE}
           (card_id, contract, phase, wallet, wallet_tdh, wallet_balance,
            wallet_unique_balance, count, count_airdrop, count_allowlist)
         values (:card, :contract, 'Airdrop', :wallet, 0, 0, 0, 1, 1, 0)`,
        { card: CARD_ID, contract: CONTRACT, wallet: W(7) }
      );
    }
  );
}

function flag(action: string) {
  return {
    contract: CONTRACT,
    claim: CARD_ID,
    action,
    write: (ctx: RequestContext) =>
      mintingClaimActionsDb.upsertAction(
        {
          contract: CONTRACT,
          claim_id: CARD_ID,
          action,
          completed: true,
          wallet: W(8)
        },
        ctx
      ),
    failed: () => Promise.reject(new Error(`flag ${action} failed`))
  };
}

const SIGNER = 'test-signer';

/** A launch whose confirmed actions complete the given claim actions. */
function launch(flags: ('PAY_ARTIST' | 'ARTIST_AIRDROP')[]): LaunchRecord {
  const data = testLaunchData();
  const [template] = data.actions;
  return {
    id: 'launch-1',
    revision: 0,
    state: 'RUNNING',
    error: null,
    updated_at: 0,
    data: {
      ...data,
      contract: CONTRACT,
      claim_id: CARD_ID,
      signer: W(8),
      completion_flags: [],
      actions: flags.map((it) =>
        it === 'PAY_ARTIST'
          ? { ...template, id: 'pay', kind: 'PAY_ARTIST', state: 'CONFIRMED' }
          : {
              ...template,
              id: 'artist',
              kind: 'AIRDROP',
              label: 'Airdrop - Artist',
              state: 'CONFIRMED'
            }
      )
    }
  };
}

const saveLaunch = (record: LaunchRecord, ctx: RequestContext) =>
  dropForgeRepository.save(record, ctx);

/** One signer pass over the launch, as the worker runs it: lock, mirror, save. */
function signerPass(
  id: string,
  during: (ctx: RequestContext) => Promise<void> = async () => undefined,
  signer = SIGNER
) {
  return dropForgeRepository.wallet(
    signer,
    async (_, ctx) => {
      // The signer's snapshot: its first plain read (find() for a targeted
      // tick) comes after the signer lock, before the launch lock and head.
      await sqlExecutor.execute(
        `select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      const record = await dropForgeRepository.lockLaunch(id, ctx);
      await mirrorCompletion(record, ctx, saveLaunch);
      await dropForgeRepository.save(record, ctx);
      await during(ctx);
      return null;
    },
    {}
  );
}

/** Everything the minting tables hold for the card, as the mint log reads it. */
function captureCard() {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    mintStateReader.capture(CARD, connection)
  );
}

/** The tables a rebuild starts from: empty, apart from rows other modules own. */
async function emptyMintTables(): Promise<void> {
  for (const table of [
    DISTRIBUTION_TABLE,
    DISTRIBUTION_NORMALIZED_TABLE,
    DISTRIBUTION_PHOTO_TABLE,
    MINTING_MERKLE_ROOTS_TABLE,
    MINTING_MERKLE_PROOFS_TABLE,
    MINTING_CLAIMS_TABLE,
    MINTING_CLAIM_ACTIONS_TABLE,
    MEME_CARD_DROP_MAPPINGS_TABLE,
    MINT_LOG_HEAD_TABLE,
    TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
  ]) {
    await sqlExecutor.execute(`delete from ${table}`);
  }
  // The subscriptions rebuild restores these rows; the mint log sets their phases.
  await sqlExecutor.execute(
    `update ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
     set phase = null, phase_subscriptions = -1, phase_position = -1`
  );
}

/**
 * The public endpoints that read the minting tables, answered by the real
 * routers, with the merkle proof of the allowlisted wallet. Minted counts
 * come from the distribution loop, which this test does not run.
 */
function endpointJson(merkleRoot: string) {
  return apiAnswers(
    [
      ['/distribution_photos', distributionPhotosRoutes],
      ['/minting-claims', mintingClaimsRoutes],
      ['', distributionsRoutes]
    ],
    [
      `/distribution_phases/${CONTRACT}/${CARD_ID}`,
      `/distributions?card_id=${CARD_ID}&contract=${CONTRACT}`,
      `/distribution_photos/${CONTRACT}/${CARD_ID}`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/roots`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/airdrops`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/allowlists`,
      `/minting-claims/${CONTRACT}/${CARD_ID}/${merkleRoot}/proofs/${W(5)}`
    ],
    ['minted', 'total_count']
  );
}

/** No genesis here: the rebuild never reads content files. */
const noContent: MintContentPort = {
  put: () => Promise.reject(new Error('no content in this test')),
  get: () => Promise.reject(new Error('no content in this test'))
};

/** An admin's logged change to one of the claim's actions. */
function adminClaimAction(action: string, completed: boolean) {
  return mintLogRecorder.write(
    {
      kind: 'claim.action',
      card: CARD,
      actor: { type: 'admin', wallet: W(9), authority: 'test' },
      intent: { route: 'claim.action', params: { action }, body: null }
    },
    () =>
      mintingClaimActionsDb.upsertAction(
        {
          contract: CONTRACT,
          claim_id: CARD_ID,
          action,
          completed,
          wallet: W(9)
        },
        {}
      )
  );
}

/** Another session's update of the card's Phase 2 row, waiting at most 2 s. */
function updatePhaseTwo(): Promise<'updated' | 'waited'> {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const options = { wrappedConnection: connection };
    await sqlExecutor.execute(
      'set session innodb_lock_wait_timeout = 2',
      undefined,
      options
    );
    try {
      await sqlExecutor.execute(
        `update ${DISTRIBUTION_TABLE} set wallet_tdh = wallet_tdh + 1
         where card_id = :card and contract = :contract and phase = 'Phase 2'`,
        { card: CARD_ID, contract: CONTRACT },
        options
      );
      return 'updated';
    } catch (error) {
      if (String(error).includes('ER_LOCK_WAIT_TIMEOUT')) return 'waited';
      throw error;
    } finally {
      await sqlExecutor.execute(
        'set session innodb_lock_wait_timeout = default',
        undefined,
        options
      );
    }
  });
}

async function claimActions(): Promise<
  { action: string; completed: number; updated_by_wallet: string }[]
> {
  const rows = await sqlExecutor.execute<{
    action: string;
    completed: number | boolean;
    updated_by_wallet: string;
  }>(
    `select action, completed, updated_by_wallet
     from ${MINTING_CLAIM_ACTIONS_TABLE} order by action`
  );
  return rows.map((row) => ({ ...row, completed: Number(row.completed) }));
}

describeWithSeed(
  "Drop Forge's writes in the mint log",
  [
    {
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [subscription(1), subscription(2)]
    }
  ],
  () => {
    const saved = { ...process.env };
    beforeAll(() => {
      process.env.FEATURE_MINT_LOG_SHADOW = 'true';
      process.env.FEATURE_MINT_LOG_REPLAY_CHECK = 'true';
    });
    afterAll(() => {
      process.env.FEATURE_MINT_LOG_SHADOW = saved.FEATURE_MINT_LOG_SHADOW;
      process.env.FEATURE_MINT_LOG_REPLAY_CHECK =
        saved.FEATURE_MINT_LOG_REPLAY_CHECK;
    });

    it("rebuilds the card from Drop Forge's own entries alone: a phase split, the public phase, finalize and a held flag", async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        workerPhase({ connection }, [phaseResult(1, 1), phaseResult(5, 1)])
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        prepareDistributionPhase(
          CONTRACT,
          CARD_ID,
          'plan-1',
          'public',
          '',
          { connection },
          { name: 'Public', rows: [] }
        )
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        finalizeDistribution(CONTRACT, CARD_ID, { connection })
      );
      await saveLaunch(launch(['PAY_ARTIST']), {});
      await signerPass('launch-1');

      const logged = await entries();
      expect(
        logged.map((entry) => [entry.kind, entry.actor.authority])
      ).toEqual([
        ['dist.phase', 'drop-forge'],
        ['dist.phase', 'drop-forge'],
        ['dist.normalize', 'drop-forge'],
        ['claim.action', 'drop-forge']
      ]);
      const live = await captureCard();
      expect(live.merkle.map((root) => root.row.phase)).toEqual(['Phase 1']);
      expect(live.normalized.length).toBeGreaterThan(0);
      expect(live.claim_actions).toHaveLength(1);
      const merkleRoot = String(live.merkle[0].row.merkle_root);
      const answers = await endpointJson(merkleRoot);
      expect(allOk(answers)).toEqual([]);

      // Drop the rows, then rebuild from the logged entries alone, through
      // the rebuild's own reducer.
      await emptyMintTables();
      expect((await captureCard()).distribution).toEqual([]);
      const result = await new MintLogRebuilder(noContent).rebuild(logged);

      expect(result.entries).toBe(4);
      expect(differingParts(await captureCard(), live)).toEqual([]);
      expect(await endpointJson(merkleRoot)).toEqual(answers);
    });

    it('logs a background public phase as a phase split with no results', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        prepareDistributionPhase(
          CONTRACT,
          CARD_ID,
          'plan-1',
          'public',
          '',
          { connection },
          { name: 'Public', rows: [] }
        )
      );

      const [entry] = await entries();
      expect(entry).toMatchObject({
        kind: 'dist.phase',
        card: CARD,
        actor: { type: 'service', authority: 'drop-forge' },
        inputs: { phase_id: 'public', allowlist_results: [] }
      });
      expect(entry.checks.replay).toBe('match');
      expect(entry.effects.distribution?.upsert.length).toBeGreaterThan(0);
    });

    it("logs Drop Forge's finalize as a normalize, with the distribution cursor block", async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        workerPhase({ connection }, [phaseResult(1, 1), phaseResult(5, 1)])
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        finalizeDistribution(CONTRACT, CARD_ID, { connection })
      );

      const logged = await entries();
      expect(logged.map((entry) => entry.kind)).toEqual([
        'dist.phase',
        'dist.normalize'
      ]);
      expect(logged[1]).toMatchObject({
        card: CARD,
        actor: { type: 'service', authority: 'drop-forge' }
      });
      // The rebuild counts mints after this block into the normalized rows.
      expect(logged[1].inputs).toHaveProperty('distribution_cursor_block');
      expect(logged[1].checks.replay).toBe('match');
      expect(logged[1].effects.normalized?.upsert.length).toBeGreaterThan(0);
    });

    it('logs a background phase preparation as a phase split, as the worker', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        workerPhase({ connection }, [phaseResult(1, 1), phaseResult(5, 1)])
      );

      const [entry] = await entries();
      expect(entry).toMatchObject({
        kind: 'dist.phase',
        card: CARD,
        actor: { type: 'service', authority: 'drop-forge' },
        inputs: {
          phase_name: 'Phase 1',
          allowlist_results: [
            [W(1), 1],
            [W(5), 1]
          ]
        }
      });
      expect(entry.checks.replay).toBe('match');
      expect(entry.effects.distribution?.upsert.length).toBeGreaterThan(0);
    });

    it("drops the entry with the rows when the job's step fails", async () => {
      await sqlExecutor.execute(
        `insert into ${DROP_FORGE_JOBS_TABLE}
           (id, contract, claim_id, kind, status, updated_at)
         values ('job-1', :contract, :claim, 'PROCESS_ALL', 'PENDING', 1)`,
        { contract: CONTRACT, claim: CARD_ID }
      );

      await dropForgeJobsRepository.processOne(
        async (_, ctx) => {
          await workerPhase(ctx, [phaseResult(1, 1), phaseResult(5, 1)]);
          throw new LaunchSafetyError('a later check failed');
        },
        {},
        'job-1'
      );

      expect(await entries()).toEqual([]);
      expect(
        await count(`select count(*) as n from ${DISTRIBUTION_TABLE}`)
      ).toBe(0);
      const [job] = await sqlExecutor.execute<{ status: string }>(
        `select status from ${DROP_FORGE_JOBS_TABLE} where id = 'job-1'`
      );
      expect(job.status).toBe('FAILED');
    });

    it("completes a job's step and an admin's logged write together, the job first", async () => {
      await sqlExecutor.execute(
        `insert into ${DROP_FORGE_JOBS_TABLE}
           (id, contract, claim_id, kind, status, updated_at)
         values ('job-1', :contract, :claim, 'PROCESS_ALL', 'PENDING', 1)`,
        { contract: CONTRACT, claim: CARD_ID }
      );
      const reached = gate();
      const release = gate();
      const job = dropForgeJobsRepository.processOne(
        async (_, ctx) => {
          await workerPhase(ctx, [phaseResult(1, 1)]);
          reached.open();
          await release.opened;
          return {};
        },
        {},
        'job-1'
      );
      let admin: Promise<void> | undefined;
      try {
        await reached.opened;
        admin = adminPhase([phaseResult(2, 1)], undefined, OTHER_CARD);
        await waitingOn(WAITS_ON_HEAD);
      } finally {
        release.open();
      }
      await Promise.all([job, admin]);

      expect((await entries()).map((entry) => entry.actor.type)).toEqual([
        'service',
        'admin'
      ]);
    });

    it("completes a job's step and an admin's logged write together, the admin first", async () => {
      await sqlExecutor.execute(
        `insert into ${DROP_FORGE_JOBS_TABLE}
           (id, contract, claim_id, kind, status, updated_at)
         values ('job-1', :contract, :claim, 'PROCESS_ALL', 'PENDING', 1)`,
        { contract: CONTRACT, claim: CARD_ID }
      );
      const reached = gate();
      const release = gate();
      const admin = adminPhase(
        [phaseResult(2, 1)],
        { reached: reached.open, until: release.opened },
        OTHER_CARD
      );
      let job: Promise<boolean> | undefined;
      try {
        await reached.opened;
        job = dropForgeJobsRepository.processOne(
          async (_, ctx) => {
            await workerPhase(ctx, [phaseResult(1, 1)]);
            return {};
          },
          {},
          'job-1'
        );
        await waitingOn(WAITS_ON_HEAD);
      } finally {
        release.open();
      }
      await Promise.all([admin, job]);

      expect((await entries()).map((entry) => entry.actor.type)).toEqual([
        'admin',
        'service'
      ]);
    });

    it('holds completion flags to the end of the signer transaction, then logs each once', async () => {
      let seenInside = -1;
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withDropForgeClaimActions({ connection }, async () => {
          await writeDropForgeClaimAction({ connection }, flag('PAY_ARTIST'));
          await writeDropForgeClaimAction(
            { connection },
            flag('ARTIST_AIRDROP')
          );
          const [row] = await sqlExecutor.execute<{ n: number }>(
            `select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`,
            undefined,
            { wrappedConnection: connection }
          );
          seenInside = Number(row.n);
        })
      );

      expect(seenInside).toBe(0);
      const logged = await entries();
      expect(logged.map((entry) => entry.kind)).toEqual([
        'claim.action',
        'claim.action'
      ]);
      expect(
        logged.map(
          (entry) => (entry.intent.params as Record<string, string>).action
        )
      ).toEqual(['PAY_ARTIST', 'ARTIST_AIRDROP']);
      expect(
        await count(`select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`)
      ).toBe(2);
    });

    it("doesn't hold the mint log's head across a chain call after a flag", async () => {
      const chainCall = gate();
      const inChainCall = gate();
      const signer = sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          withDropForgeClaimActions({ connection }, async () => {
            await writeDropForgeClaimAction({ connection }, flag('PAY_ARTIST'));
            // A slow chain call after the flag, in the same transaction.
            inChainCall.open();
            await chainCall.opened;
          })
      );
      try {
        await inChainCall.opened;
        // Another logged write takes the head and finishes meanwhile.
        await within(plainWrite(), 'the other logged write');
      } finally {
        chainCall.open();
      }
      await signer;

      expect((await entries()).map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'claim.action'
      ]);
    });

    it('writes no flag and logs nothing when the signer transaction fails', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withDropForgeClaimActions({ connection }, async () => {
            await writeDropForgeClaimAction({ connection }, flag('PAY_ARTIST'));
            throw new Error('the chain call failed');
          })
        )
      ).rejects.toThrow('the chain call failed');

      expect(await entries()).toEqual([]);
      expect(
        await count(`select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`)
      ).toBe(0);
    });

    it('refuses a second hold on the same transaction, and commits no flag', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withDropForgeClaimActions({ connection }, async () => {
            await writeDropForgeClaimAction({ connection }, flag('PAY_ARTIST'));
            await withDropForgeClaimActions({ connection }, async () => {
              await writeDropForgeClaimAction(
                { connection },
                flag('TEAM_AIRDROP')
              );
            });
          })
        )
      ).rejects.toThrow('already holds claim actions');

      expect(await entries()).toEqual([]);
      expect(
        await count(`select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`)
      ).toBe(0);
    });

    it('refuses a flag queued once the flags are being written, and commits none', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withDropForgeClaimActions({ connection }, async () => {
            await writeDropForgeClaimAction(
              { connection },
              {
                ...flag('PAY_ARTIST'),
                write: async (ctx) => {
                  await flag('PAY_ARTIST').write(ctx);
                  await writeDropForgeClaimAction(ctx, flag('TEAM_AIRDROP'));
                }
              }
            );
          })
        )
      ).rejects.toThrow('queued after');

      expect(await entries()).toEqual([]);
      expect(
        await count(`select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`)
      ).toBe(0);
    });

    it("reads current rows for Drop Forge's writes only: an admin's READ COMMITTED write locks none it doesn't write", async () => {
      await sqlExecutor.execute(
        `insert into ${DISTRIBUTION_TABLE}
           (card_id, contract, phase, wallet, wallet_tdh, wallet_balance,
            wallet_unique_balance, count, count_airdrop, count_allowlist)
         values (:card, :contract, 'Phase 2', :wallet, 0, 0, 0, 1, 0, 1)`,
        { card: CARD_ID, contract: CONTRACT, wallet: W(6) }
      );
      const reached = gate();
      const release = gate();
      const admin = adminPhase([phaseResult(5, 1)], {
        reached: reached.open,
        until: release.opened
      });
      try {
        await within(reached.opened, "the admin's write");
        expect(await updatePhaseTwo()).toBe('updated');
      } finally {
        release.open();
      }
      await admin;

      const forgeReached = gate();
      const forgeRelease = gate();
      const forge = sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          mintLogRecorder.writeWithin(
            dropForgePhaseSpec({
              contract: CONTRACT,
              claim: CARD_ID,
              plan: 'plan-1',
              phase: 'phase-1',
              phaseName: 'Phase 1',
              results: []
            }),
            connection,
            async () => {
              forgeReached.open();
              await forgeRelease.opened;
            }
          )
      );
      try {
        await within(forgeReached.opened, "Drop Forge's write");
        // Drop Forge's capture read the card's rows with FOR UPDATE.
        expect(await updatePhaseTwo()).toBe('waited');
      } finally {
        forgeRelease.open();
      }
      await forge;
    });

    it("holds a launch's flags to the end of the signer pass, past a slow chain call, and logs each once", async () => {
      await saveLaunch(launch(['PAY_ARTIST']), {});
      const chainCall = gate();
      const inChainCall = gate();
      let writtenBeforeChainCall = -1;
      const pass = signerPass('launch-1', async (ctx) => {
        // Read in the signer transaction itself: the flag is held, not
        // written, when the chain call starts.
        writtenBeforeChainCall = await count(
          `select count(*) as n from ${MINTING_CLAIM_ACTIONS_TABLE}`,
          ctx
        );
        inChainCall.open();
        await chainCall.opened;
      });
      try {
        await within(inChainCall.opened, 'the signer pass');
        // The head is free during the chain call.
        await within(plainWrite(), 'the other logged write');
      } finally {
        chainCall.open();
      }
      await pass;

      expect(writtenBeforeChainCall).toBe(0);
      expect((await entries()).map((entry) => entry.kind)).toEqual([
        'dist.airdrops',
        'claim.action'
      ]);
      expect(await claimActions()).toEqual([
        { action: 'PAY_ARTIST', completed: 1, updated_by_wallet: W(8) }
      ]);
      const stored = await dropForgeRepository.find('launch-1', {});
      expect(stored?.data.completion_flags).toEqual(['PAY_ARTIST']);
    });

    it("logs an admin's change to the same claim action made during the pass first, then the flag over it: last writer wins", async () => {
      await saveLaunch(launch(['PAY_ARTIST']), {});
      await signerPass('launch-1', () =>
        within(adminClaimAction('PAY_ARTIST', false), "the admin's write")
      );

      const logged = await entries();
      expect(
        logged.map((entry) => [entry.actor.type, entry.checks.replay])
      ).toEqual([
        ['admin', 'match'],
        ['service', 'match']
      ]);
      expect(logged[1].effects.claim_actions?.upsert).toHaveLength(1);
      expect(await claimActions()).toEqual([
        { action: 'PAY_ARTIST', completed: 1, updated_by_wallet: W(8) }
      ]);
    });

    it('undoes a held flag that fails alone, commits the rest with no gap in the seq, and writes the flag on the next pass', async () => {
      await plainWrite();
      await saveLaunch(launch(['PAY_ARTIST', 'ARTIST_AIRDROP']), {});
      const upsert = mintingClaimActionsDb.upsertAction.bind(
        mintingClaimActionsDb
      );
      const failing = jest
        .spyOn(mintingClaimActionsDb, 'upsertAction')
        .mockImplementation(async (param, ctx) => {
          // The row is written, then the write fails: the savepoint must
          // take the row back with the entry.
          await upsert(param, ctx);
          if (param.action === 'PAY_ARTIST') {
            throw Object.assign(new Error('Lock wait timeout exceeded'), {
              code: 'ER_LOCK_WAIT_TIMEOUT'
            });
          }
        });
      try {
        await signerPass('launch-1');
      } finally {
        failing.mockRestore();
      }

      let logged = await entries();
      expect(
        logged.map((entry) => [
          entry.kind,
          (entry.intent.params as Record<string, string>).action ?? null
        ])
      ).toEqual([
        ['dist.airdrops', null],
        ['claim.action', 'ARTIST_AIRDROP']
      ]);
      expect(logged.map((entry) => entry.seq)).toEqual([
        logged[0].seq,
        logged[0].seq + 1
      ]);
      expect(await claimActions()).toEqual([
        { action: 'ARTIST_AIRDROP', completed: 1, updated_by_wallet: W(8) }
      ]);
      const afterFailure = await dropForgeRepository.find('launch-1', {});
      const events = afterFailure?.data.events ?? [];
      // Not blocked: the flag is bookkeeping, retried on the next pass.
      expect(afterFailure?.state).toBe('RUNNING');
      expect(afterFailure?.data.completion_flags).toEqual(['ARTIST_AIRDROP']);
      expect(events[events.length - 1]).toMatchObject({
        error: true,
        content: expect.stringContaining(
          'completion flag PAY_ARTIST was not written (ER_LOCK_WAIT_TIMEOUT)'
        )
      });

      await signerPass('launch-1');

      logged = await entries();
      expect(logged.map((entry) => entry.seq)).toEqual([
        logged[0].seq,
        logged[0].seq + 1,
        logged[0].seq + 2
      ]);
      expect((logged[2].intent.params as Record<string, string>).action).toBe(
        'PAY_ARTIST'
      );
      expect((await claimActions()).map((row) => row.action)).toEqual([
        'ARTIST_AIRDROP',
        'PAY_ARTIST'
      ]);
      expect(
        (await dropForgeRepository.find('launch-1', {}))?.data.completion_flags
      ).toEqual(['ARTIST_AIRDROP', 'PAY_ARTIST']);
    });

    it('in primary mode, undoes a held flag that fails after its entry is appended and the head advanced, and the next flag takes its seq', async () => {
      await saveLaunch(launch(['PAY_ARTIST', 'ARTIST_AIRDROP']), {});
      const head = (mintLogRecorder as unknown as { head: MintLogHeadDb }).head;
      const advance = head.advance.bind(head);
      const failing = jest
        .spyOn(head, 'advance')
        .mockImplementationOnce(async (...args) => {
          await advance(...args);
          throw new Error('the connection dropped after the advance');
        });
      process.env.FEATURE_MINT_LOG_PRIMARY = 'true';
      try {
        await signerPass('launch-1');
      } finally {
        process.env.FEATURE_MINT_LOG_PRIMARY = saved.FEATURE_MINT_LOG_PRIMARY;
        failing.mockRestore();
      }

      const logged = await entries();
      expect(
        logged.map(
          (entry) => (entry.intent.params as Record<string, string>).action
        )
      ).toEqual(['ARTIST_AIRDROP']);
      // The head starts at -1: the failed flag's entry 0 went back with
      // its savepoint, and the next flag took seq 0.
      expect(logged[0].seq).toBe(0);
      expect(
        await count(`select max(seq) as n from ${MINT_LOG_HEAD_TABLE}`)
      ).toBe(0);
      expect(await claimActions()).toEqual([
        { action: 'ARTIST_AIRDROP', completed: 1, updated_by_wallet: W(8) }
      ]);
      expect(
        (await dropForgeRepository.find('launch-1', {}))?.data.completion_flags
      ).toEqual(['ARTIST_AIRDROP']);
    });

    /**
     * Holds the mint chain's head in a transaction of its own, as another
     * card's phase step or an admin's split would, while `during` runs.
     */
    async function holdingTheHead<T>(during: () => Promise<T>): Promise<T> {
      const head = (mintLogRecorder as unknown as { head: MintLogHeadDb }).head;
      const locked = gate();
      const release = gate();
      const holder = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await head.lock(connection, 'mint');
          locked.open();
          await release.opened;
        }
      );
      try {
        await locked.opened;
        return await during();
      } finally {
        release.open();
        await holder;
      }
    }

    /** A signer pass with its time taken, in milliseconds. */
    async function timedPass(id: string, capped = true): Promise<number> {
      const started = Date.now();
      const pass = signerPass(id);
      await (capped ? within(pass, 'the signer pass') : pass);
      return Date.now() - started;
    }

    const BOUND_MS = HELD_FLAG_LOCK_WAIT_SECONDS * 1000;

    it(`in primary mode, a held flag gives up on a held head after ${HELD_FLAG_LOCK_WAIT_SECONDS} s; the pass commits, the flag is unmirrored and written on the next pass`, async () => {
      await saveLaunch(launch(['PAY_ARTIST']), {});
      process.env.FEATURE_MINT_LOG_PRIMARY = 'true';
      try {
        const waited = await holdingTheHead(() => timedPass('launch-1', false));
        expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 500);
        expect(waited).toBeLessThan(BOUND_MS + 4000);
        expect(await claimActions()).toEqual([]);
        expect(await entries()).toEqual([]);
        const record = await dropForgeRepository.find('launch-1', {});
        expect(record?.state).toBe('RUNNING');
        expect(record?.data.completion_flags).toEqual([]);
        const events = record?.data.events ?? [];
        expect(events[events.length - 1]).toMatchObject({
          error: true,
          content: expect.stringContaining(
            'completion flag PAY_ARTIST was not written (ER_LOCK_WAIT_TIMEOUT)'
          )
        });

        await signerPass('launch-1');
      } finally {
        process.env.FEATURE_MINT_LOG_PRIMARY = saved.FEATURE_MINT_LOG_PRIMARY;
      }

      expect(await claimActions()).toEqual([
        { action: 'PAY_ARTIST', completed: 1, updated_by_wallet: W(8) }
      ]);
      expect((await entries()).map((entry) => entry.kind)).toEqual([
        'claim.action'
      ]);
    }, 60_000);

    it(`in shadow mode, a held flag gives up on a held head after ${HELD_FLAG_LOCK_WAIT_SECONDS} s and commits unlogged, alerting once the pass commits`, async () => {
      await saveLaunch(launch(['PAY_ARTIST']), {});
      const alerts = jest
        .spyOn(priorityAlerts, 'sendPriorityAlertIfConfigured')
        .mockResolvedValue(undefined);
      try {
        const waited = await holdingTheHead(() => timedPass('launch-1', false));
        expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 500);
        expect(waited).toBeLessThan(BOUND_MS + 4000);
        expect(alerts).toHaveBeenCalledTimes(1);
        expect(String(alerts.mock.calls[0][1])).toContain(
          '[MINT_LOG_SHADOW_FAILED] [claim.action]'
        );
      } finally {
        alerts.mockRestore();
      }

      // The flag is written and mirrored, with no entry: a gap that the
      // genesis before primary covers.
      expect(await claimActions()).toEqual([
        { action: 'PAY_ARTIST', completed: 1, updated_by_wallet: W(8) }
      ]);
      expect(await entries()).toEqual([]);
      expect(
        (await dropForgeRepository.find('launch-1', {}))?.data.completion_flags
      ).toEqual(['PAY_ARTIST']);
    }, 60_000);

    it(`gives a pass's held flags one ${HELD_FLAG_LOCK_WAIT_SECONDS} s budget for the head: the second flag waits ${HELD_FLAG_MIN_LOCK_WAIT_SECONDS} s more, not ${HELD_FLAG_LOCK_WAIT_SECONDS} s`, async () => {
      await saveLaunch(launch(['PAY_ARTIST', 'ARTIST_AIRDROP']), {});
      process.env.FEATURE_MINT_LOG_PRIMARY = 'true';
      try {
        const waited = await holdingTheHead(() => timedPass('launch-1', false));
        // A bound per flag would let this pass wait twice the budget.
        const pass = BOUND_MS + HELD_FLAG_MIN_LOCK_WAIT_SECONDS * 1000;
        expect(waited).toBeGreaterThanOrEqual(pass - 500);
        expect(waited).toBeLessThan(pass + 4000);
        expect(await claimActions()).toEqual([]);
        expect(await entries()).toEqual([]);
        const record = await dropForgeRepository.find('launch-1', {});
        expect(record?.data.completion_flags).toEqual([]);
        for (const flag of ['PAY_ARTIST', 'ARTIST_AIRDROP']) {
          expect(
            record?.data.events.some(
              (event) =>
                event.error &&
                event.content.includes(
                  `completion flag ${flag} was not written (ER_LOCK_WAIT_TIMEOUT)`
                )
            )
          ).toBe(true);
        }

        await signerPass('launch-1');
      } finally {
        process.env.FEATURE_MINT_LOG_PRIMARY = saved.FEATURE_MINT_LOG_PRIMARY;
      }

      expect((await claimActions()).map((row) => row.action)).toEqual([
        'ARTIST_AIRDROP',
        'PAY_ARTIST'
      ]);
      expect((await entries()).map((entry) => entry.kind)).toEqual([
        'claim.action',
        'claim.action'
      ]);
    }, 60_000);

    it("lets a second card's held flag wait for the head while the first card's flag holds it, and write within the bound", async () => {
      await saveLaunch(launch(['PAY_ARTIST']), {});
      const other = launch(['PAY_ARTIST']);
      await saveLaunch(
        {
          ...other,
          id: 'launch-other',
          data: { ...other.data, claim_id: OTHER_CARD }
        },
        {}
      );
      const reached = gate();
      const release = gate();
      const upsert = mintingClaimActionsDb.upsertAction.bind(
        mintingClaimActionsDb
      );
      // The first card's flag holds the head while it is written, as a
      // flag on a large card does while its captures run.
      const slow = jest
        .spyOn(mintingClaimActionsDb, 'upsertAction')
        .mockImplementation(async (param, ctx) => {
          if (param.claim_id === CARD_ID) {
            reached.open();
            await release.opened;
          }
          return upsert(param, ctx);
        });
      let waited = 0;
      try {
        const first = signerPass('launch-1');
        await reached.opened;
        const started = Date.now();
        const second = signerPass(
          'launch-other',
          undefined,
          'test-signer-other'
        );
        await waitingOn(WAITS_ON_HEAD);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        release.open();
        await Promise.all([first, second]);
        waited = Date.now() - started;
      } finally {
        release.open();
        slow.mockRestore();
      }

      expect(waited).toBeGreaterThanOrEqual(3000);
      expect(waited).toBeLessThan(BOUND_MS);
      const logged = await entries();
      expect(logged.map((entry) => [entry.kind, entry.card?.card_id])).toEqual([
        ['claim.action', CARD_ID],
        ['claim.action', OTHER_CARD]
      ]);
      expect(logged.map((entry) => entry.checks.replay)).toEqual([
        'match',
        'match'
      ]);
      for (const id of ['launch-1', 'launch-other']) {
        const record = await dropForgeRepository.find(id, {});
        expect(record?.data.completion_flags).toEqual(['PAY_ARTIST']);
        expect(record?.data.events.some((event) => event.error)).toBe(false);
      }
    }, 60_000);

    it('measures what one held flag adds to a signer pass on a full memes card, with the replay check on', async () => {
      // A busy memes card: one phase with WALLETS allowlisted wallets (their
      // distribution rows, the merkle root and a proof each), its normalized
      // rows, and SUBSCRIBERS final subscription rows.
      const WALLETS = 4000;
      const SUBSCRIBERS = 2000;
      for (let start = 0; start < SUBSCRIBERS; start += 500) {
        const rows = Array.from(
          { length: Math.min(500, SUBSCRIBERS - start) },
          (_, i) => subscription(10_000 + start + i)
        );
        const columns = Object.keys(rows[0]);
        const values = rows
          .map(
            (_, i) =>
              `(${columns.map((column) => `:${column}_${i}`).join(', ')})`
          )
          .join(', ');
        const params = Object.fromEntries(
          rows.flatMap((row, i) =>
            columns.map((column) => [
              `${column}_${i}`,
              (row as Record<string, unknown>)[column]
            ])
          )
        );
        await sqlExecutor.execute(
          `insert into ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} (${columns.join(', ')}) values ${values}`,
          params
        );
      }
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        workerPhase(
          { connection },
          Array.from({ length: WALLETS }, (_, i) => phaseResult(100 + i, 1))
        )
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        finalizeDistribution(CONTRACT, CARD_ID, { connection })
      );
      const sizes = {
        distribution: await count(
          `select count(*) as n from ${DISTRIBUTION_TABLE}`
        ),
        normalized: await count(
          `select count(*) as n from ${DISTRIBUTION_NORMALIZED_TABLE}`
        ),
        proofs: await count(
          `select count(*) as n from ${MINTING_MERKLE_PROOFS_TABLE}`
        ),
        proofBytes: await count(
          `select sum(length(proofs)) as n from ${MINTING_MERKLE_PROOFS_TABLE}`
        ),
        final: await count(
          `select count(*) as n from ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
        )
      };
      expect(sizes.distribution).toBeGreaterThanOrEqual(WALLETS);
      expect(sizes.proofs).toBeGreaterThanOrEqual(WALLETS);

      // The same pass, each with one flag: the mint log off, then in shadow
      // with the replay check on (four captures of the card).
      await saveLaunch({ ...launch(['ARTIST_AIRDROP']), id: 'launch-off' }, {});
      process.env.FEATURE_MINT_LOG_SHADOW = 'false';
      let off: number;
      try {
        off = await timedPass('launch-off', false);
      } finally {
        process.env.FEATURE_MINT_LOG_SHADOW = 'true';
      }
      await saveLaunch(launch(['PAY_ARTIST']), {});
      const logged = await timedPass('launch-1', false);

      const flagEntries = (await entries()).filter(
        (entry) => entry.kind === 'claim.action'
      );
      expect(flagEntries).toHaveLength(1);
      expect(flagEntries[0].checks.replay).toBe('match');
      Logger.get('MINT_LOG_FLAG_TIMING').info(
        JSON.stringify({
          ...sizes,
          off_ms: off,
          logged_ms: logged,
          added_ms: logged - off
        })
      );
      // A guard against a regression, well above what it measures.
      expect(logged - off).toBeLessThan(30_000);
    }, 180_000);
  }
);
