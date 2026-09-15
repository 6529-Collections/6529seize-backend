import { fixtureCleanupScope } from './membership-runtime-fixture-setup-cleanup';
import { SqlExecutor } from '@/sql-executor';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_GRANT_TOKENS_TABLE
} from '@/constants';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  MembershipFixtureControlDb,
  FixtureControl
} from './membership-runtime-fixture-control';
import {
  assertMembershipFixtureEnvironment,
  MembershipFixtureEnvironment
} from './membership-runtime-fixture-setup-schema';
import {
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES
} from './membership-runtime-policy';
import {
  fixtureAddress,
  fixtureGroup,
  fixtureWave,
  MEMBERSHIP_FIXTURE_CLEANUP_TABLES,
  MEMBERSHIP_FIXTURE_EXCLUSION_LIST,
  MEMBERSHIP_FIXTURE_GRANTED_GRANT,
  MEMBERSHIP_FIXTURE_INCLUSION_LIST,
  MEMBERSHIP_FIXTURE_JOB,
  MEMBERSHIP_FIXTURE_MANIFEST_HASH,
  MEMBERSHIP_FIXTURE_PARTITION,
  MEMBERSHIP_FIXTURE_PENDING_GRANT,
  MEMBERSHIP_FIXTURE_SOURCE_KEYS,
  MEMBERSHIP_FIXTURE_TOKENSET
} from './membership-runtime-fixture-manifest';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb
} from './membership-source-states.db';
import {
  MembershipSourceJobsDb,
  MEMBERSHIP_TDH_COMPLETION_STAGE
} from './membership-source-jobs.db';
import { MembershipFixtureScenarios } from './membership-runtime-fixture-scenarios';

const fullRequest = [
  { scope: 'FULL' as const, target_id: '*', reason: 'staging-fixture-v1' }
];
/** No transport/network side effects: caller commits each bounded setup quantum. */
export class MembershipFixtureSetupService {
  private readonly control: MembershipFixtureControlDb;
  private readonly sources: MembershipSourceStatesDb;
  private readonly jobs: MembershipSourceJobsDb;
  constructor(
    private readonly db: SqlExecutor,
    environment: MembershipFixtureEnvironment
  ) {
    assertMembershipFixtureEnvironment(environment);
    this.control = new MembershipFixtureControlDb(db);
    this.sources = new MembershipSourceStatesDb(() => db);
    this.jobs = new MembershipSourceJobsDb(() => db);
  }
  /** Requires the create-only schema helper to have returned ready in this deployment. */
  async prepare(ctx: MembershipPrimaryContext): Promise<FixtureControl> {
    return timeMembershipOperation(
      'MembershipFixtureSetupService->prepare',
      ctx,
      async () => {
        const existing = await this.control.read(ctx, true);
        if (!existing) {
          for (const table of MEMBERSHIP_FIXTURE_CLEANUP_TABLES) {
            if (
              (
                await this.db.execute(
                  `SELECT 1 FROM ${table} LIMIT 1`,
                  undefined,
                  membershipQueryOptions(ctx)
                )
              ).length
            )
              throw new Error('Cannot adopt populated unowned fixture inputs');
          }
          return this.control.initialize(MEMBERSHIP_FIXTURE_MANIFEST_HASH, ctx);
        }
        this.validate(existing);
        const state = existing.state;
        if (state.setup_stage === 'SCHEMA_READY') {
          await this.sources.provision(
            MEMBERSHIP_FIXTURE_SOURCE_KEYS,
            {
              bootstrap_id: 'staging-fixture-v1',
              coverage_revision: `fixture-only-spec2-${MEMBERSHIP_FIXTURE_MANIFEST_HASH}`
            },
            ctx
          );
          await this.jobs.start(
            MEMBERSHIP_FIXTURE_JOB,
            { stage: 'INPUTS', after_id: null },
            ctx
          );
          return this.control.update(
            existing.revision,
            { ...state, setup_stage: 'PROVISIONED' },
            ctx
          );
        }
        if (state.setup_stage === 'PROVISIONED')
          return this.prepareInputPage(existing, ctx);
        if (state.setup_stage === 'INPUTS_READY') {
          await this.sources.mutate(
            {
              keys: [MEMBERSHIP_CATALOG_KEY],
              requests: fullRequest,
              group_changes: MEMBERSHIP_FIXTURE_GROUPS.map((group_id) => ({
                group_id,
                is_deleted: false
              }))
            },
            async (primary) => {
              await this.insert(
                USER_GROUPS_TABLE,
                MEMBERSHIP_FIXTURE_GROUPS.map((_, index) =>
                  fixtureGroup(index)
                ),
                primary
              );
              await this.insert(
                WAVES_TABLE,
                MEMBERSHIP_FIXTURE_GROUPS.map((_, index) =>
                  fixtureWave(index, state.anchor_millis)
                ),
                primary
              );
            },
            ctx
          );
          return this.control.update(
            existing.revision,
            { ...state, setup_stage: 'CATALOGUED' },
            ctx
          );
        }
        if (state.setup_stage === 'CATALOGUED') {
          const job = await this.jobs.start(
            MEMBERSHIP_FIXTURE_JOB,
            { stage: 'INPUTS', after_id: null },
            ctx
          );
          if (
            job.progress.stage !== MEMBERSHIP_TDH_COMPLETION_STAGE ||
            job.progress.after_id !== MEMBERSHIP_FIXTURE_PROFILES[2]
          )
            throw new Error('Fixture source inputs are incomplete');
          await this.jobs.complete(
            MEMBERSHIP_FIXTURE_JOB,
            job.progress,
            fullRequest,
            async () => undefined,
            ctx
          );
          return this.control.update(
            existing.revision,
            { ...state, setup_stage: 'READY' },
            ctx
          );
        }
        if (state.setup_stage !== 'READY')
          throw new Error('Cleaned fixture cannot be automatically reused');
        return existing;
      }
    );
  }
  private validate(control: FixtureControl): void {
    if (control.manifest_hash !== MEMBERSHIP_FIXTURE_MANIFEST_HASH)
      throw new Error('Fixture manifest mismatch');
  }
  private async owned(
    ctx: MembershipPrimaryContext,
    lock = true
  ): Promise<FixtureControl> {
    const control = await this.control.read(ctx, lock);
    if (!control) throw new Error('Fixture has no ownership marker');
    this.validate(control);
    return control;
  }
  private async prepareInputPage(
    control: FixtureControl,
    ctx: MembershipPrimaryContext
  ) {
    const page = control.state.input_page;
    if (page >= 3) throw new Error('Invalid fixture input progress');
    const job = await this.jobs.start(
      MEMBERSHIP_FIXTURE_JOB,
      { stage: 'INPUTS', after_id: null },
      ctx
    );
    const expectedAfter = page ? MEMBERSHIP_FIXTURE_PROFILES[page - 1] : null;
    if (
      job.progress.stage !== 'INPUTS' ||
      job.progress.after_id !== expectedAfter ||
      job.progress.revision !== String(page)
    )
      throw new Error('Fixture job/control progress mismatch');
    const last = page === 2;
    await this.jobs.checkpoint(
      MEMBERSHIP_FIXTURE_JOB,
      job.progress,
      {
        stage: last ? MEMBERSHIP_TDH_COMPLETION_STAGE : 'INPUTS',
        after_id: MEMBERSHIP_FIXTURE_PROFILES[page]
      },
      (primary) =>
        this.writeInputPage(page, control.state.anchor_millis, primary),
      ctx
    );
    return this.control.update(
      control.revision,
      {
        ...control.state,
        input_page: page + 1,
        setup_stage: last ? 'INPUTS_READY' : 'PROVISIONED'
      },
      ctx
    );
  }
  private async insert(
    table: string,
    rows: Record<string, unknown>[],
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    if (!rows.length || rows.length > 64)
      throw new Error('Invalid fixed fixture insert size');
    // Every table/column originates in this module's immutable manifest, never an event.
    const columns = Array.from(
      new Set(rows.flatMap((row) => Object.keys(row)))
    );
    const params: Record<string, unknown> = {};
    const values = rows.map(
      (row, index) =>
        `(${columns
          .map((column, offset) => {
            if (!Object.prototype.hasOwnProperty.call(row, column))
              return 'DEFAULT';
            const key = `p${index}_${offset}`;
            params[key] = row[column] ?? null;
            return `:${key}`;
          })
          .join(',')})`
    );
    await this.db.execute(
      `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(',')}) VALUES ${values.join(',')}`,
      params,
      membershipQueryOptions(ctx)
    );
  }
  private async writeInputPage(
    page: number,
    anchor: string,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const profile = MEMBERSHIP_FIXTURE_PROFILES[page];
    const address = fixtureAddress(page);
    await this.insert(
      IDENTITIES_TABLE,
      [
        {
          consolidation_key: address,
          profile_id: profile,
          primary_address: address,
          tdh: page < 2 ? 10 : 0,
          rep: 0,
          cic: 0,
          level_raw: 0
        }
      ],
      ctx
    );
    await this.insert(
      ADDRESS_CONSOLIDATION_KEY,
      [{ address, consolidation_key: address }],
      ctx
    );
    if (page < 2) {
      await this.insert(
        NFT_OWNERS_TABLE,
        [
          {
            wallet: address,
            contract: MEMES_CONTRACT,
            token_id: page + 1,
            balance: 1,
            block_reference: 1
          }
        ],
        ctx
      );
      await this.insert(
        EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
        [
          {
            partition: MEMBERSHIP_FIXTURE_PARTITION,
            token_id: String(page + 1),
            owner: address,
            since_block: 1,
            since_time: anchor,
            created_at: anchor,
            updated_at: anchor
          }
        ],
        ctx
      );
    }
    if (page !== 1)
      await this.insert(
        PROFILE_GROUPS_TABLE,
        [
          {
            profile_group_id: MEMBERSHIP_FIXTURE_EXCLUSION_LIST,
            profile_id: profile
          }
        ],
        ctx
      );
    if (page === 0) {
      await this.insert(
        PROFILE_GROUPS_TABLE,
        [
          {
            profile_group_id: MEMBERSHIP_FIXTURE_INCLUSION_LIST,
            profile_id: profile
          }
        ],
        ctx
      );
      await this.writeGrants(anchor, ctx);
    }
    if (page === 1)
      await this.insert(
        RATINGS_TABLE,
        [
          {
            rater_profile_id: profile,
            matter_target_id: MEMBERSHIP_FIXTURE_PROFILES[0],
            matter: 'REP',
            matter_category: 'membership-drill',
            rating: 2,
            last_modified: '2026-01-01 00:00:00'
          }
        ],
        ctx
      );
  }
  private async writeGrants(anchor: string, ctx: MembershipPrimaryContext) {
    await this.insert(
      XTDH_GRANTS_TABLE,
      [MEMBERSHIP_FIXTURE_GRANTED_GRANT, MEMBERSHIP_FIXTURE_PENDING_GRANT].map(
        (id, index) => ({
          id,
          tokenset_id: MEMBERSHIP_FIXTURE_TOKENSET,
          grantor_id: MEMBERSHIP_FIXTURE_PROFILES[0],
          target_chain: 1,
          target_contract: fixtureAddress(99),
          target_partition: MEMBERSHIP_FIXTURE_PARTITION,
          token_mode: 'INCLUDE',
          created_at: anchor,
          updated_at: anchor,
          valid_from: index ? String(BigInt(anchor) + BigInt(7200000)) : anchor,
          valid_to: index ? String(BigInt(anchor) + BigInt(10800000)) : null,
          rate: 1,
          status: index ? 'PENDING' : 'GRANTED',
          is_irrevocable: 0
        })
      ),
      ctx
    );
    await this.insert(
      XTDH_GRANT_TOKENS_TABLE,
      [1, 2].map((token) => ({
        tokenset_id: MEMBERSHIP_FIXTURE_TOKENSET,
        token_id: String(token),
        target_partition: MEMBERSHIP_FIXTURE_PARTITION
      })),
      ctx
    );
  }
  async status(ctx: MembershipPrimaryContext) {
    return timeMembershipOperation(
      'MembershipFixtureSetupService->status',
      ctx,
      async () => {
        const control = await this.owned(ctx, false);
        const targets = await this.db.execute<{
          scope: string;
          target_id: string;
          requested_version: string;
          completed_version: string;
          available_at_millis: string | null;
          active_run_id: string | null;
          attempts: number;
          last_error: string | null;
        }>(
          `SELECT scope,target_id,CAST(requested_version AS CHAR) requested_version,CAST(completed_version AS CHAR) completed_version,CAST(available_at_millis AS CHAR) available_at_millis,active_run_id,attempts,last_error FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} ORDER BY scope,target_id LIMIT 41`,
          undefined,
          membershipQueryOptions(ctx)
        );
        const publications = await this.db.execute<{
          profile_id: string;
          run_id: string;
          published_at_millis: string;
        }>(
          `SELECT profile_id,run_id,CAST(published_at_millis AS CHAR) published_at_millis FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} LIMIT 4`,
          undefined,
          membershipQueryOptions(ctx)
        );
        const candidates = await this.db.execute<{
          id: string;
          is_pure_profile_group: number;
        }>(
          `SELECT g.id,g.is_pure_profile_group FROM ${USER_GROUPS_TABLE} g WHERE g.visible=1 AND EXISTS(SELECT 1 FROM ${WAVES_TABLE} w WHERE w.visibility_group_id=g.id) ORDER BY g.id LIMIT 37`,
          undefined,
          membershipQueryOptions(ctx)
        );
        const sources = await this.sources.read(
          MEMBERSHIP_FIXTURE_SOURCE_KEYS,
          false,
          ctx
        );
        if (
          targets.length > 40 ||
          publications.length > 3 ||
          candidates.length > 36
        )
          throw new Error('Fixture status exceeds manifest bounds');
        if (
          candidates.some(
            (row) => !MEMBERSHIP_FIXTURE_GROUPS.includes(row.id)
          ) ||
          publications.some(
            (row) =>
              !(MEMBERSHIP_FIXTURE_PROFILES as readonly string[]).includes(
                row.profile_id
              )
          ) ||
          targets.some((row) => !this.knownTarget(row.scope, row.target_id))
        )
          throw new Error('Fixture status found an unowned row');
        if (
          control.state.setup_stage === 'READY' &&
          (candidates.length !== 36 ||
            candidates.some((row) => Number(row.is_pure_profile_group) !== 0))
        )
          throw new Error('Fixture broad candidate proof is incomplete');
        const runIds = Array.from(
          new Set(
            [
              ...targets.map((row) => row.active_run_id),
              ...publications.map((row) => row.run_id),
              control.state.proof?.source_change?.run_id,
              control.state.proof?.boundary?.captured?.run_id,
              control.state.proof?.boundary?.false_publication_run_id,
              control.state.proof?.identity_retry?.previous_publication_run_id,
              control.state.proof?.fanout?.captured?.run_id
            ].filter((id): id is string => typeof id === 'string')
          )
        );
        const runs = runIds.length
          ? await this.db.execute<Record<string, unknown>>(
              `SELECT id,scope,target_id,status,CAST(checkpoint_version AS CHAR) checkpoint_version,CAST(processed_count AS CHAR) processed_count,CAST(catalog_version AS CHAR) catalog_version,CAST(evaluation_time_millis AS CHAR) evaluation_time_millis,CAST(valid_until_millis AS CHAR) valid_until_millis,LEFT(JSON_UNQUOTE(JSON_EXTRACT(progress_cursor,'$.after_id')),200) after_id,LEFT(JSON_UNQUOTE(JSON_EXTRACT(progress_cursor,'$.through_id')),200) through_id FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE id IN (:ids) LIMIT 49`,
              { ids: runIds },
              membershipQueryOptions(ctx)
            )
          : [];
        const jobs = await this.db.execute<Record<string, unknown>>(
          `SELECT scope,target_id,dimension,status,CAST(started_version AS CHAR) started_version,CAST(completed_version AS CHAR) completed_version,LEFT(JSON_UNQUOTE(JSON_EXTRACT(progress,'$.stage')),100) stage FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE} WHERE job_id=:id LIMIT 25`,
          { id: MEMBERSHIP_FIXTURE_JOB.job_id },
          membershipQueryOptions(ctx)
        );
        if (jobs.length > 24)
          throw new Error('Fixture job evidence exceeds manifest');
        return {
          control,
          targets,
          publications,
          runs,
          jobs,
          candidates,
          sources: sources.map(({ key, state, provisioned }) => ({
            ...key,
            version: state?.version ?? null,
            active_jobs: state?.active_jobs ?? null,
            provisioned
          }))
        };
      }
    );
  }
  private knownTarget(scope: unknown, id: unknown): boolean {
    if (scope === 'FULL') return id === '*';
    if (typeof id !== 'string') return false;
    if (scope === 'GROUP') return MEMBERSHIP_FIXTURE_GROUPS.includes(id);
    return (
      scope === 'PROFILE' &&
      (MEMBERSHIP_FIXTURE_PROFILES as readonly string[]).includes(id)
    );
  }
  async advance(ctx: MembershipPrimaryContext): Promise<FixtureControl> {
    return timeMembershipOperation(
      'MembershipFixtureSetupService->advance',
      ctx,
      async () => {
        const control = await this.owned(ctx, false);
        if (control.state.setup_stage !== 'READY')
          throw new Error('Fixture inputs are not ready');
        if (control.state.transport?.phase === 'HELD')
          return this.control.update(
            control.revision,
            {
              ...control.state,
              transport: { ...control.state.transport, phase: 'CORRECTED' }
            },
            ctx
          );
        const state = await new MembershipFixtureScenarios(this.db).advance(
          control.state,
          ctx
        );
        return this.control.update(control.revision, state, ctx);
      }
    );
  }
  /** Caller proves actual dispatcher/mapping shutdown before invoking this closed action. */
  async cleanup(ctx: MembershipPrimaryContext): Promise<FixtureControl> {
    return timeMembershipOperation(
      'MembershipFixtureSetupService->cleanup',
      ctx,
      async () => {
        const control = await this.owned(ctx, false);
        if (control.state.setup_stage === 'CLEANED') return control;
        const options = membershipQueryOptions(ctx);
        if (
          (
            await this.db.execute(
              `SELECT 1 FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE} WHERE lease_token IS NOT NULL AND lease_expires_at_millis>${MEMBERSHIP_DB_NOW} LIMIT 1`,
              undefined,
              options
            )
          ).length
        )
          throw new Error('Fixture has a live worker lease');
        if (
          (
            await this.db.execute(
              `SELECT 1 FROM ${MEMBERSHIP_SOURCE_STATES_TABLE} WHERE active_jobs<>0 LIMIT 1`,
              undefined,
              options
            )
          ).length
        )
          throw new Error('Fixture has an active source producer');
        const rows = await this.db.execute<{ now: string }>(
          `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
          undefined,
          options
        );
        const now = BigInt(rows[0].now);
        const proofOwner = control.state.proof?.db_runtime?.owner;
        if (proofOwner && BigInt(proofOwner.expires_at_millis) > now)
          throw new Error('Fixture has an active database proof reader');
        if (control.state.setup_stage !== 'CLEANING') {
          if (control.state.setup_stage !== 'READY')
            throw new Error('Fixture setup must finish before cleanup');
          return this.control.update(
            control.revision,
            {
              ...control.state,
              setup_stage: 'CLEANING',
              cleanup_table: 0,
              cleanup_not_before_millis: String(now + BigInt(120000))
            },
            ctx
          );
        }
        if (now < BigInt(control.state.cleanup_not_before_millis!))
          throw new Error('Fixture cleanup reader grace has not elapsed');
        const index = control.state.cleanup_table!;
        const table = MEMBERSHIP_FIXTURE_CLEANUP_TABLES[index];
        if (!table) throw new Error('Invalid fixture cleanup table cursor');
        const scope = fixtureCleanupScope(table);
        if (
          (
            await this.db.execute(
              `SELECT 1 FROM ${table} WHERE COALESCE((${scope.where}),0)=0 LIMIT 1`,
              scope.params,
              options
            )
          ).length
        )
          throw new Error('Fixture cleanup found an unowned row');
        await this.db.execute(
          `DELETE FROM ${table} WHERE ${scope.where} LIMIT 128`,
          scope.params,
          options
        );
        const remains =
          (
            await this.db.execute(
              `SELECT 1 FROM ${table} LIMIT 1`,
              undefined,
              options
            )
          ).length > 0;
        const next = remains ? index : index + 1;
        return this.control.update(
          control.revision,
          {
            ...control.state,
            cleanup_table: next,
            setup_stage:
              next === MEMBERSHIP_FIXTURE_CLEANUP_TABLES.length
                ? 'CLEANED'
                : 'CLEANING'
          },
          ctx
        );
      }
    );
  }
}
