import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { FixtureState } from './membership-runtime-fixture-control';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { fixtureAddress } from './membership-runtime-fixture-manifest';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipFixtureScenarioDb } from './membership-runtime-fixture-scenario.db';

const [long, transport, empty] = MEMBERSHIP_FIXTURE_PROFILES;
const profileKey = { scope: 'PROFILE' as const, target_id: transport };
const peerKey = { scope: 'PROFILE' as const, target_id: long };
const fullKey = { scope: 'FULL' as const, target_id: '*' };
const identityKeys = [
  { scope: 'GLOBAL' as const, target_id: '*', dimension: 'IDENTITY' as const },
  { ...profileKey, dimension: 'IDENTITY' as const }
];
const reason = 'staging-fixture-identity-v2';

/** Fixed missing-identity failure and creation beyond the FULL snapshot high bound. */
export class MembershipFixtureIdentityScenario {
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
      case 'EMPTY':
        return this.removeIdentity(state, ctx);
      case 'IDENTITY_MISSING':
        return this.observeRetry(state, ctx);
      case 'FANOUT_WAIT':
        return this.restoreBeyondHighBound(state, ctx);
      case 'FANOUT_CAPTURED':
        return this.completeFanoutProof(state, ctx);
      default:
        throw new Error('Fixture scenario sequence is complete');
    }
  }
  private async settledCohort(ctx: MembershipPrimaryContext) {
    for (const profile of MEMBERSHIP_FIXTURE_PROFILES)
      await this.evidence.published(profile, ctx);
    const full = await this.evidence.target(fullKey, ctx);
    if (
      full.active_run_id !== null ||
      full.completed_version !== full.requested_version
    )
      throw new Error('Fixture FULL fanout has not settled');
  }
  private async removeIdentity(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    if (state.transport?.phase !== 'CORRECTED')
      throw new Error(
        'Fixture transport correction must settle before identity removal'
      );
    await this.settledCohort(ctx);
    const publication = await this.evidence.published(empty, ctx);
    const members = await this.db.execute(
      `SELECT 1 FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} WHERE run_id=:run LIMIT 1`,
      { run: publication.id },
      membershipQueryOptions(ctx)
    );
    if (members.length)
      throw new Error('Fixture requires a completed empty publication');
    const prior = await this.evidence.publicationId(transport, ctx);
    await this.sources.mutate(
      {
        keys: identityKeys,
        requests: [
          { ...profileKey, reason },
          { ...peerKey, reason }
        ]
      },
      async (primary) => {
        await this.requireIdentity(true, primary);
        await this.db.execute(
          `DELETE FROM ${IDENTITIES_TABLE} WHERE consolidation_key=:key AND profile_id=:profile AND primary_address=:key`,
          { key: fixtureAddress(1), profile: transport },
          membershipQueryOptions(primary)
        );
        await this.requireIdentity(false, primary);
      },
      ctx
    );
    return {
      ...state,
      scenario: 'IDENTITY_MISSING',
      proof: {
        ...state.proof!,
        identity_retry: {
          requested_version: (await this.evidence.target(profileKey, ctx))
            .requested_version,
          peer_requested_version: (await this.evidence.target(peerKey, ctx))
            .requested_version,
          previous_publication_run_id: prior,
          observations: [],
          parked_observed_at_millis: null
        }
      }
    };
  }
  private async requireIdentity(
    present: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const rows = await this.db.execute<{
      consolidation_key: string;
      primary_address: string;
    }>(
      `SELECT consolidation_key,primary_address FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile LIMIT 2`,
      { profile: transport },
      membershipQueryOptions(ctx)
    );
    if (!present && rows.length === 0) return;
    if (
      present &&
      rows.length === 1 &&
      rows[0].consolidation_key === fixtureAddress(1) &&
      rows[0].primary_address === fixtureAddress(1)
    )
      return;
    throw new Error(
      'Fixture canonical transport identity contradicts its scenario'
    );
  }
  private async observeRetry(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    await this.requireIdentity(false, ctx);
    const proof = state.proof!;
    const retry = proof.identity_retry!;
    const target = await this.evidence.target(profileKey, ctx);
    const now = await this.evidence.runs.now(ctx);
    if (
      target.requested_version !== retry.requested_version ||
      target.active_run_id !== null ||
      target.last_error !== 'IDENTITY_NOT_FOUND' ||
      target.attempts < 1 ||
      target.attempts > 3 ||
      (await this.evidence.publicationId(transport, ctx)) !==
        retry.previous_publication_run_id
    )
      throw new Error(
        'Fixture requires a real missing-identity retry with unchanged publication'
      );
    const prior = retry.observations[retry.observations.length - 1];
    if (prior && target.attempts <= prior.attempts)
      throw new Error('Fixture is waiting for the next durable retry attempt');
    if (
      target.attempts < 3 &&
      (target.available_at_millis === null ||
        BigInt(target.available_at_millis) <= BigInt(now))
    )
      throw new Error('Fixture retry backoff observation is no longer current');
    if (target.attempts === 3 && target.available_at_millis !== null)
      throw new Error('Fixture target has not reached durable park');
    const updated = {
      ...retry,
      observations: [
        ...retry.observations,
        {
          attempts: target.attempts,
          observed_at_millis: now,
          available_at_millis: target.available_at_millis
        }
      ]
    };
    if (target.attempts < 3)
      return { ...state, proof: { ...proof, identity_retry: updated } };
    // A missed operator sample can restart the exact target through the ordinary
    // new-request contract; no retry counter or availability is repaired by SQL.
    if (
      !retry.observations.some((entry) => entry.available_at_millis !== null)
    ) {
      const requested = await this.evidence.request(profileKey, ctx);
      return {
        ...state,
        proof: {
          ...proof,
          identity_retry: {
            ...retry,
            requested_version: requested.requested_version,
            observations: []
          }
        }
      };
    }
    await this.peerProgress(retry.peer_requested_version, ctx);
    const full = await this.evidence.request(fullKey, ctx);
    return {
      ...state,
      scenario: 'FANOUT_WAIT',
      proof: {
        ...proof,
        identity_retry: { ...updated, parked_observed_at_millis: now },
        fanout: { request_version: full.requested_version, captured: null }
      }
    };
  }
  private async peerProgress(version: string, ctx: MembershipPrimaryContext) {
    const target = await this.evidence.target(peerKey, ctx);
    const id =
      target.active_run_id ?? (await this.evidence.publicationId(long, ctx));
    const run = await this.evidence.runs.run(id, false, ctx);
    if (
      !run ||
      BigInt(run.request_version) < BigInt(version) ||
      run.checkpoint_version === '0' ||
      !['PENDING', 'RUNNING', 'COMPLETED'].includes(run.status)
    )
      throw new Error(
        'Fixture independent profile has not progressed during retry'
      );
  }
  private async restoreBeyondHighBound(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const proof = state.proof!;
    const fanout = proof.fanout!;
    const target = await this.evidence.target(fullKey, ctx);
    const run = target.active_run_id
      ? await this.evidence.runs.run(target.active_run_id, false, ctx)
      : null;
    if (
      !run ||
      run.scope !== 'FULL' ||
      run.request_version !== fanout.request_version ||
      !['PENDING', 'RUNNING'].includes(run.status) ||
      run.progress_cursor.kind !== 'PROFILE_FANOUT' ||
      run.progress_cursor.phase !== 'SCAN' ||
      run.progress_cursor.through_id !== long ||
      run.progress_cursor.after_id !== empty ||
      run.checkpoint_version === '0'
    )
      throw new Error(
        'Fixture requires the first fixed-H FULL checkpoint before identity restoration'
      );
    const parked = await this.evidence.target(profileKey, ctx);
    if (
      parked.requested_version !== proof.identity_retry!.requested_version ||
      parked.attempts !== 3 ||
      parked.available_at_millis !== null
    )
      throw new Error('Fixture missing identity is no longer parked');
    await this.sources.mutate(
      { keys: identityKeys, requests: [{ ...profileKey, reason }] },
      async (primary) => {
        // Hold IDENTITY, then parent target/run, before restoring a child beyond H.
        // Final fanout acknowledgement cannot pass this creation transaction.
        const lockedTarget = await this.evidence.runs.target(
          fullKey,
          true,
          primary
        );
        const lockedRun = await this.evidence.runs.run(run.id, true, primary);
        if (
          lockedTarget?.active_run_id !== run.id ||
          lockedRun?.checkpoint_version !== run.checkpoint_version ||
          lockedRun?.progress_cursor.phase !== 'SCAN'
        )
          throw new Error(
            'Fixture FULL checkpoint changed before identity restoration'
          );
        await this.requireIdentity(false, primary);
        await this.db.execute(
          `INSERT INTO ${IDENTITIES_TABLE} (consolidation_key,profile_id,primary_address,tdh,rep,cic,level_raw) VALUES (:key,:profile,:key,10,0,0,0)`,
          { key: fixtureAddress(1), profile: transport },
          membershipQueryOptions(primary)
        );
        await this.requireIdentity(true, primary);
      },
      ctx
    );
    return {
      ...state,
      scenario: 'FANOUT_CAPTURED',
      proof: {
        ...proof,
        fanout: {
          ...fanout,
          captured: {
            run_id: run.id,
            checkpoint_version: run.checkpoint_version,
            through_id: long,
            after_id: empty,
            restored_profile_request_version: (
              await this.evidence.target(profileKey, ctx)
            ).requested_version,
            completed_observed_at_millis: null
          }
        }
      }
    };
  }
  private async completeFanoutProof(
    state: FixtureState,
    ctx: MembershipPrimaryContext
  ): Promise<FixtureState> {
    const proof = state.proof!;
    const fanout = proof.fanout!;
    const captured = fanout.captured!;
    const target = await this.evidence.target(profileKey, ctx);
    if (target.requested_version !== captured.restored_profile_request_version)
      throw new Error(
        'Fixture beyond-H profile request was unexpectedly advanced'
      );
    if (captured.completed_observed_at_millis === null) {
      const run = await this.evidence.runs.run(captured.run_id, false, ctx);
      const full = await this.evidence.target(fullKey, ctx);
      if (
        !run ||
        run.status !== 'COMPLETED' ||
        run.progress_cursor.through_id !== captured.through_id ||
        run.request_version !== fanout.request_version ||
        BigInt(full.completed_version) < BigInt(fanout.request_version)
      )
        throw new Error(
          'Fixture FULL acknowledgement has not completed with its captured high bound'
        );
      return {
        ...state,
        proof: {
          ...proof,
          fanout: {
            ...fanout,
            captured: {
              ...captured,
              completed_observed_at_millis: await this.evidence.runs.now(ctx)
            }
          }
        }
      };
    }
    await this.settledCohort(ctx);
    if (target.attempts !== 0 || target.last_error !== null)
      throw new Error(
        'Fixture restored identity retry state has not recovered'
      );
    return { ...state, scenario: 'IDENTITY_RECOVERED' };
  }
}
