import { IDENTITIES_TABLE, XTDH_GRANTS_TABLE } from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { FixtureState } from './membership-runtime-fixture-control';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { MEMBERSHIP_DB_NOW } from './membership-repository.utils';
import {
  fixtureAddress,
  MEMBERSHIP_FIXTURE_PENDING_GRANT
} from './membership-runtime-fixture-manifest';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipFixtureScenarioDb } from './membership-runtime-fixture-scenario.db';
import { MembershipFixtureIdentityScenario } from './membership-runtime-fixture-identity-scenario';
import { normalizeCounter } from './membership-validation';
import { MembershipWorkerSourcesDb } from './membership-worker-sources.db';

const long = MEMBERSHIP_FIXTURE_PROFILES[0];
const full = { scope: 'FULL' as const, target_id: '*' };
const grantKey = {
  scope: 'GLOBAL' as const,
  target_id: '*',
  dimension: 'GRANTS' as const
};
const proofOf = (state: FixtureState) =>
  state.proof ?? { protocol_version: 1 as const };

/** One closed source/evidence quantum. Network wakeups remain independently scheduled. */
export class MembershipFixtureScenarios {
  private readonly evidence: MembershipFixtureScenarioDb;
  private readonly sources: MembershipSourceStatesDb;
  constructor(private readonly db: SqlExecutor) {
    this.evidence = new MembershipFixtureScenarioDb(db);
    this.sources = new MembershipSourceStatesDb(() => db);
  }
  async advance(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    switch (state.scenario) {
      case 'BASELINE':
        await this.evidence.published(long, ctx);
        await this.evidence.request({ scope: 'PROFILE', target_id: long }, ctx);
        return { ...state, scenario: 'MISSED_WAKEUP' };
      case 'MISSED_WAKEUP':
        return this.changeSource(state, ctx);
      case 'SOURCE_CHANGE':
        return this.armBoundary(state, ctx);
      case 'EXPIRY_WAIT':
        return this.captureBoundary(state, ctx);
      case 'BOUNDARY_CAPTURED':
        return this.proveBoundary(state, ctx);
      case 'GRANT_ACTIVE':
        await this.evidence.membership(
          await this.evidence.published(long, ctx),
          32,
          true,
          ctx
        );
        await this.mutateGrant("status='DISABLED'", ctx);
        return { ...state, scenario: 'GRANT_DISABLED' };
      case 'GRANT_DISABLED':
        await this.evidence.membership(
          await this.evidence.published(long, ctx),
          32,
          false,
          ctx
        );
        await this.evidence.request(
          { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[2] },
          ctx
        );
        return { ...state, scenario: 'EMPTY' };
      default:
        return new MembershipFixtureIdentityScenario(this.db).advance(
          state,
          ctx
        );
    }
  }
  private async changeSource(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const partial = await this.evidence.partial(long, ctx);
    const failedSend = state.dispatch_send_failure;
    if (
      !failedSend ||
      partial.request_version !== failedSend.requested_version ||
      BigInt(await this.evidence.runs.now(ctx)) <
        BigInt(failedSend.reserved_until_millis)
    )
      throw new Error(
        'Fixture requires natural recovery after the recorded dispatcher send failure'
      );
    const previous = await this.evidence.publicationId(long, ctx);
    const target = { scope: 'PROFILE' as const, target_id: long };
    await this.sources.mutate(
      {
        keys: [{ ...target, dimension: 'TDH_XTDH' }],
        requests: [{ ...target, reason: 'staging-fixture-source-v2' }]
      },
      async (primary) => {
        const lockedTarget = await this.evidence.runs.target(
          target,
          true,
          primary
        );
        const lockedRun = await this.evidence.runs.run(
          partial.id,
          true,
          primary
        );
        if (
          !lockedRun ||
          lockedTarget?.active_run_id !== partial.id ||
          lockedRun.progress_cursor.phase !== 'SCAN' ||
          !['PENDING', 'RUNNING'].includes(lockedRun.status) ||
          BigInt(lockedRun.processed_count) >= BigInt(36)
        )
          throw new Error('Fixture source change lost its active partial run');
        await this.db.execute(
          `UPDATE ${IDENTITIES_TABLE} SET tdh=20 WHERE profile_id=:profile AND consolidation_key=:key`,
          { profile: long, key: fixtureAddress(0) },
          membershipQueryOptions(primary)
        );
      },
      ctx
    );
    return {
      ...state,
      scenario: 'SOURCE_CHANGE',
      proof: {
        ...proofOf(state),
        source_change: {
          run_id: partial.id,
          previous_publication_run_id: previous,
          requested_version: (await this.evidence.target(target, ctx))
            .requested_version,
          superseded_observed_at_millis: null
        }
      }
    };
  }
  private async armBoundary(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const source = state.proof!.source_change!;
    if (source.superseded_observed_at_millis === null)
      return {
        ...state,
        proof: {
          ...proofOf(state),
          source_change: {
            ...source,
            superseded_observed_at_millis: await this.evidence.superseded(
              source.run_id,
              ctx
            )
          }
        }
      };
    const publication = await this.evidence.published(long, ctx);
    if (
      publication.id === source.previous_publication_run_id ||
      BigInt(publication.request_version) < BigInt(source.requested_version)
    )
      throw new Error('Fixture source change has no fresh publication');
    await this.mutateGrant(
      `valid_from=${MEMBERSHIP_DB_NOW}+300000,valid_to=NULL`,
      ctx
    );
    const grant = await this.grant(ctx);
    const [version] = await this.sources.read([grantKey], false, ctx);
    return {
      ...state,
      scenario: 'EXPIRY_WAIT',
      proof: {
        ...proofOf(state),
        boundary: {
          boundary_millis: grant.valid_from,
          full_request_version: (await this.evidence.target(full, ctx))
            .requested_version,
          grants_version: normalizeCounter(version.state?.version),
          captured: null,
          false_publication_run_id: null
        }
      }
    };
  }
  private async captureBoundary(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const boundary = state.proof!.boundary!;
    const run = await this.evidence.partial(long, ctx);
    await new MembershipWorkerSourcesDb(() => this.db).validateSources(
      run,
      false,
      ctx
    );
    const now = await this.evidence.runs.now(ctx);
    if (
      run.valid_until_millis !== boundary.boundary_millis ||
      BigInt(run.evaluation_time_millis) >= BigInt(boundary.boundary_millis) ||
      BigInt(now) >= BigInt(boundary.boundary_millis) ||
      run.source_versions.find(
        (key) => key.scope === 'GLOBAL' && key.dimension === 'GRANTS'
      )?.version !== boundary.grants_version
    )
      throw new Error(
        'Fixture requires a real partial run before its captured boundary'
      );
    return {
      ...state,
      scenario: 'BOUNDARY_CAPTURED',
      proof: {
        ...proofOf(state),
        boundary: {
          ...boundary,
          captured: {
            run_id: run.id,
            request_version: run.request_version,
            checkpoint_version: run.checkpoint_version,
            evaluation_time_millis: run.evaluation_time_millis,
            valid_until_millis: run.valid_until_millis,
            superseded_observed_at_millis: null
          }
        }
      }
    };
  }
  private async proveBoundary(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const boundary = state.proof!.boundary!;
    const captured = boundary.captured!;
    const now = await this.evidence.runs.now(ctx);
    if (BigInt(now) < BigInt(boundary.boundary_millis))
      throw new Error('Fixture grant boundary has not arrived');
    if (captured.superseded_observed_at_millis === null) {
      await this.requireExpiredRun(
        captured.run_id,
        boundary.boundary_millis,
        ctx
      );
      return {
        ...state,
        proof: {
          ...proofOf(state),
          boundary: {
            ...boundary,
            captured: {
              ...captured,
              superseded_observed_at_millis: now
            }
          }
        }
      };
    }
    const publication = await this.evidence.published(long, ctx);
    const grant = await this.grant(ctx);
    if (
      grant.status !== 'PENDING' ||
      grant.valid_from !== boundary.boundary_millis ||
      publication.id === captured.run_id ||
      BigInt(publication.evaluation_time_millis) <
        BigInt(boundary.boundary_millis) ||
      publication.source_versions.find(
        (key) => key.scope === 'GLOBAL' && key.dimension === 'GRANTS'
      )?.version !== boundary.grants_version
    )
      throw new Error(
        'Fixture requires a false post-boundary publication before status activation'
      );
    await this.evidence.membership(publication, 32, false, ctx);
    await this.evidence.membership(publication, 0, false, ctx);
    await this.mutateGrant("status='GRANTED'", ctx);
    return {
      ...state,
      scenario: 'GRANT_ACTIVE',
      proof: {
        ...proofOf(state),
        boundary: {
          ...boundary,
          false_publication_run_id: publication.id
        }
      }
    };
  }
  private async grant(ctx: MembershipPrimaryContext) {
    const grant = await this.db.oneOrNull<{
      valid_from: string;
      status: string;
    }>(
      `SELECT CAST(valid_from AS CHAR) valid_from,status FROM ${XTDH_GRANTS_TABLE} WHERE id=:id`,
      { id: MEMBERSHIP_FIXTURE_PENDING_GRANT },
      membershipQueryOptions(ctx)
    );
    if (!grant) throw new Error('Fixture grant is missing');
    return { ...grant, valid_from: normalizeCounter(grant.valid_from) };
  }
  private async requireExpiredRun(
    id: string,
    horizon: string,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const run = await this.evidence.runs.run(id, false, ctx);
    const target = await this.evidence.target(
      { scope: 'PROFILE', target_id: long },
      ctx
    );
    if (
      !run ||
      run.status !== 'SUPERSEDED' ||
      run.valid_until_millis !== horizon ||
      target.last_error !== 'EXPIRED'
    )
      throw new Error('Fixture requires observed horizon expiry supersession');
    await new MembershipWorkerSourcesDb(() => this.db).validateSources(
      run,
      false,
      ctx
    );
  }
  private async mutateGrant(
    assignment: string,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    await this.sources.mutate(
      {
        keys: [grantKey],
        requests: [{ ...full, reason: 'staging-fixture-grant-v2' }]
      },
      async (primary) => {
        await this.db.execute(
          `UPDATE ${XTDH_GRANTS_TABLE} SET ${assignment},updated_at=${MEMBERSHIP_DB_NOW} WHERE id=:id`,
          { id: MEMBERSHIP_FIXTURE_PENDING_GRANT },
          membershipQueryOptions(primary)
        );
      },
      ctx
    );
  }
}
