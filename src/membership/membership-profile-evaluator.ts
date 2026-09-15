import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { Network } from '@/alchemy-sdk';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import {
  FilterDirection,
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode
} from '@/entities/IUserGroup';
import { getLevelFromScore } from '@/profiles/profile-level';
import {
  hasGroupGotAnyNonIdentityConditions,
  isProfileViolatingGroupsProfileCicCriteria,
  isProfileViolatingGroupsProfileLevelCriteria,
  isProfileViolatingGroupsProfileRepCriteria,
  isProfileViolatingGroupsProfileTdhCriteria,
  isRatingOutOfBounds
} from '@/groups/user-group-predicates';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  assertMembershipWorkBudget,
  membershipExecutionBudget,
  MembershipPrimaryContext
} from '@/membership/membership-primary';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from '@/membership/membership-repository.utils';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb
} from '@/membership/membership-source-states.db';
import {
  assertMembershipBoundedInteger,
  assertMembershipId,
  MembershipSourceKey,
  normalizeCounter,
  normalizeSourceVector,
  orderedSourceKeys
} from '@/membership/membership-validation';
import {
  ActiveInputV1,
  MembershipEvaluationError,
  MembershipEvaluationQuantumInput,
  MembershipEvaluationQuantumResult,
  MembershipProfileEvaluationSeed,
  MembershipProfileEvaluator
} from '@/membership/membership-evaluator.types';
import {
  MembershipEvaluationInputsDb,
  MembershipGrantInput,
  MembershipGroupInput,
  MembershipIdentityInput,
  MembershipMeteredExecutor,
  MembershipRatingAxis,
  MEMBERSHIP_MATCH_COLUMNS,
  MEMBERSHIP_OWNS_COLUMNS
} from '@/membership/membership-evaluation-inputs.db';
import {
  membershipFingerprint,
  membershipInteger,
  membershipTruth,
  membershipSeedFingerprint,
  minimumMembershipHorizon,
  validateMembershipActiveInput
} from '@/membership/membership-evaluation-validation';
import { MembershipCandidatePlanDb } from '@/membership/membership-candidate-plan.db';

export const MEMBERSHIP_EVALUATOR_SPEC_VERSION = 2;
export function membershipProfileSourceKeys(
  profile: string
): MembershipSourceKey[] {
  assertMembershipId(profile, 'profile ID', 50);
  const keys: MembershipSourceKey[] = [MEMBERSHIP_CATALOG_KEY];
  for (const dimension of [
    'TDH_XTDH',
    'RATINGS',
    'OWNERSHIP',
    'DELEGATIONS',
    'GRANTS',
    'IDENTITY'
  ] as const)
    keys.push(
      { scope: 'GLOBAL', target_id: '*', dimension },
      { scope: 'PROFILE', target_id: profile, dimension }
    );
  return orderedSourceKeys(keys);
}
const contracts = [
  MEMES_CONTRACT,
  GRADIENT_CONTRACT,
  NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET],
  MEMELAB_CONTRACT
];
function ratingAxis(
  plan: MembershipGroupInput,
  axis: 'CIC' | 'REP'
): MembershipRatingAxis | null {
  const g = plan.group;
  const cic = axis === 'CIC';
  const user = cic ? g.cic_user : g.rep_user;
  const category = cic ? null : g.rep_category;
  const incoming =
    (cic ? g.cic_direction : g.rep_direction) !== FilterDirection.Sent;
  const hasBounds =
    (cic ? g.cic_min : g.rep_min) !== null ||
    (cic ? g.cic_max : g.rep_max) !== null;
  if (user === null && category === null && (incoming || !hasBounds))
    return null;
  return {
    matter: axis,
    incoming,
    user,
    category,
    total: user === null && category === null
  };
}
function grantFingerprint(grant: MembershipGrantInput | null): string | null {
  return grant === null ? null : membershipFingerprint(grant);
}
function planFingerprint(plan: MembershipGroupInput): string {
  return membershipFingerprint([
    plan.group,
    plan.token_counts,
    plan.token_types
  ]);
}
function grantHorizon(
  grant: MembershipGrantInput | null,
  time: string
): string | null {
  let result: string | null = null;
  for (const date of [grant?.valid_from, grant?.valid_to])
    if (date !== null && date !== undefined) {
      const value = normalizeCounter(date);
      if (BigInt(value) > BigInt(time))
        result = minimumMembershipHorizon(result, value);
    }
  return result;
}
function nextRating(active: ActiveInputV1, axis: 'CIC' | 'REP'): void {
  active.stage = {
    kind: 'RATING',
    axis,
    after: { category: null, other_profile_id: null },
    signed_sum: '0',
    matching_count: '0'
  };
}
function nextNft(
  active: ActiveInputV1,
  slot: number,
  plan: MembershipGroupInput
): void {
  let next = slot;
  while (next < 4 && !plan.group[MEMBERSHIP_OWNS_COLUMNS[next]]) next++;
  if (next === 4) {
    active.stage = {
      kind: 'GRANT_INCLUDE',
      after_token_id: null,
      selected_count: '0',
      owned_count: '0'
    };
    return;
  }
  if (plan.token_types[next] !== null && plan.token_types[next] !== 'ARRAY')
    throw new MembershipEvaluationError(
      'INTEGRITY',
      'NFT requirements must be a native JSON array'
    );
  active.stage =
    plan.token_counts[next] === 0
      ? {
          kind: 'NFT_ANY',
          contract_slot: next,
          wallets: { after_wallet: null }
        }
      : {
          kind: 'NFT_REQUIREMENT',
          contract_slot: next,
          next_json_index: '0',
          current_token: null,
          after_owner_wallet: null
        };
}
function safeSum(value: string, change: number): string {
  const sum = BigInt(value) + BigInt(change);
  if (sum < -(BigInt(1) << BigInt(127)) || sum >= BigInt(1) << BigInt(127))
    throw new MembershipEvaluationError(
      'NUMERIC_DOMAIN_UNSUPPORTED',
      'Membership rating accumulator overflow'
    );
  return String(sum);
}

/** Authoritative primary evaluator; successful yields contain only completed raw units. */
export class PrimaryMembershipProfileEvaluator
  extends LazyDbAccessCompatibleService
  implements MembershipProfileEvaluator
{
  constructor(getDb = dbSupplier) {
    super(getDb);
  }
  async captureProfile(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipProfileEvaluationSeed> {
    return timeMembershipOperation(
      'MembershipEvaluator->captureProfile',
      ctx,
      async () => {
        assertMembershipWorkBudget(ctx);
        const source_versions = await new MembershipSourceStatesDb(
          () => this.db
        ).capture(membershipProfileSourceKeys(profile), false, ctx);
        const inputs = new MembershipEvaluationInputsDb(this.db);
        const identity = await inputs.identity(profile, ctx);
        const [clock] = await inputs.read<{ now: string }>(
          `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
          {},
          ctx
        );
        return {
          profile_id: profile,
          identity_consolidation_key: identity.consolidation_key,
          spec_version: MEMBERSHIP_EVALUATOR_SPEC_VERSION,
          source_versions,
          catalog_version: source_versions.find(
            (v) => v.dimension === 'GROUP_CATALOG'
          )!.version,
          evaluation_time_millis: normalizeCounter(clock.now),
          through_group_id: await inputs.highBound(ctx)
        };
      }
    );
  }
  async evaluateQuantum(
    input: MembershipEvaluationQuantumInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipEvaluationQuantumResult> {
    return timeMembershipOperation(
      'MembershipEvaluator->evaluateQuantum',
      ctx,
      async () => this.quantum(input, ctx)
    );
  }
  private validate(
    input: MembershipEvaluationQuantumInput,
    ctx: MembershipPrimaryContext
  ): void {
    assertMembershipWorkBudget(ctx);
    assertMembershipId(input.profile_id, 'profile ID', 50);
    if (input.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION)
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Unsupported membership spec'
      );
    normalizeCounter(input.evaluation_time_millis);
    normalizeCounter(input.catalog_version);
    if (
      typeof input.identity_consolidation_key !== 'string' ||
      input.identity_consolidation_key.length > 200 ||
      Buffer.byteLength(input.identity_consolidation_key) > 800
    )
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Invalid captured identity key'
      );
    for (const id of [input.after_group_id, input.through_group_id])
      if (id !== null) assertMembershipId(id, 'group cursor', 200);
    assertMembershipBoundedInteger(
      input.max_scanned_groups,
      'group limit',
      1,
      128
    );
    assertMembershipBoundedInteger(
      input.max_query_millis,
      'statement limit',
      1,
      60000
    );
    assertMembershipBoundedInteger(
      input.limits.max_queries,
      'query limit',
      64,
      2048
    );
    assertMembershipBoundedInteger(
      input.limits.max_input_rows,
      'input row limit',
      1024,
      1000000
    );
    assertMembershipBoundedInteger(
      input.limits.max_input_bytes,
      'input byte limit',
      65536,
      16777216
    );
    assertMembershipBoundedInteger(
      input.limits.max_windows,
      'input window limit',
      1,
      256
    );
    assertMembershipBoundedInteger(
      input.limits.raw_window,
      'raw window',
      1,
      256
    );
    const budget = membershipExecutionBudget(ctx);
    if (
      !Number.isFinite(input.deadline_monotonic_millis) ||
      input.deadline_monotonic_millis > budget.workDeadlineMonotonicMillis ||
      input.max_query_millis > budget.maxStatementMillis
    )
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Evaluator limits exceed primary execution scope'
      );
  }
  private async quantum(
    input: MembershipEvaluationQuantumInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipEvaluationQuantumResult> {
    this.validate(input, ctx);
    const expected = normalizeSourceVector(
      input.source_versions,
      membershipProfileSourceKeys(input.profile_id)
    );
    if (
      expected.find((v) => v.dimension === 'GROUP_CATALOG')!.version !==
      input.catalog_version
    )
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Catalogue seed and vector disagree'
      );
    const seed = { ...input, source_versions: expected };
    const meter = new MembershipMeteredExecutor(this.db, input, ctx);
    const inputs = new MembershipEvaluationInputsDb(meter);
    const current = await new MembershipSourceStatesDb(() => meter).capture(
      membershipProfileSourceKeys(input.profile_id),
      false,
      ctx
    );
    for (let n = 0; n < current.length; n++)
      if (
        current[n].dimension !== 'GROUP_CATALOG' &&
        current[n].version !== expected[n].version
      )
        throw new MembershipEvaluationError(
          'SOURCE_CHANGED',
          'Membership source vector changed'
        );
    const catalogue = current.find(
      (v) => v.dimension === 'GROUP_CATALOG'
    )!.version;
    if (BigInt(catalogue) < BigInt(input.catalog_version))
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Catalogue version regressed'
      );
    const identity = await inputs.identity(input.profile_id, ctx);
    if (identity.consolidation_key !== input.identity_consolidation_key)
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Canonical identity key changed without source evidence'
      );
    const [clock] = await inputs.read<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      ctx
    );
    const now = normalizeCounter(clock.now);
    if (BigInt(input.evaluation_time_millis) > BigInt(now))
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Membership evaluation time is in the future'
      );
    if (
      input.after_group_id !== null &&
      !(await inputs.isGroupRangeValid(
        input.after_group_id,
        null,
        input.through_group_id,
        ctx
      ))
    )
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Invalid membership group frontier'
      );
    let active =
      input.active_input === null
        ? null
        : validateMembershipActiveInput(input.active_input);
    if (
      active &&
      (active.seed_fingerprint !== membershipSeedFingerprint(seed) ||
        !(await inputs.isGroupRangeValid(
          active.group_id,
          input.after_group_id,
          input.through_group_id,
          ctx
        )))
    )
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Membership continuation seed/frontier mismatch'
      );
    let horizon = active?.valid_until_millis ?? null;
    let after = input.after_group_id;
    let scanned = 0;
    let windows = 0;
    const eligible: string[] = [];
    const page = active
      ? { ids: [active.group_id], after_group_id: active.group_id, done: false }
      : await new MembershipCandidatePlanDb(inputs).page(input, ctx);
    for (const id of page.ids) {
      if (!active && !meter.canStart(8, input.limits.raw_window * 2 + 32))
        break;
      assertMembershipId(id, 'candidate group ID', 200);
      const plan = await inputs.group(id, catalogue, ctx);
      if (plan === null) {
        active = null;
        after = id;
        scanned++;
        continue;
      }
      const grant = await inputs.grant(
        plan.group.is_beneficiary_of_grant_id,
        ctx
      );
      if (
        active &&
        active.group_version === plan.group_version &&
        (active.scalar_plan_fingerprint !== planFingerprint(plan) ||
          active.grant_metadata_fingerprint !== grantFingerprint(grant))
      )
        throw new MembershipEvaluationError(
          'INTEGRITY',
          'Input metadata changed without version evidence'
        );
      if (!active || active.group_version !== plan.group_version)
        active = {
          protocol_version: 1,
          seed_fingerprint: membershipSeedFingerprint(seed),
          group_id: id,
          group_version: plan.group_version,
          scalar_plan_fingerprint: planFingerprint(plan),
          grant_metadata_fingerprint: grantFingerprint(grant),
          valid_until_millis: grantHorizon(grant, input.evaluation_time_millis),
          stage: {
            kind: 'LISTS',
            after_list_id: null,
            included: false,
            excluded: false
          }
        };
      horizon = minimumMembershipHorizon(horizon, active.valid_until_millis);
      this.requireFuture(horizon, now);
      let finished = false;
      while (
        windows < input.limits.max_windows &&
        meter.canStart(4, input.limits.raw_window * 2 + 4)
      ) {
        const result = await this.step(
          active,
          plan,
          grant,
          identity,
          seed,
          inputs,
          ctx
        );
        windows++;
        if (result !== null) {
          if (result) eligible.push(id);
          active = null;
          after = id;
          scanned++;
          finished = true;
          break;
        }
      }
      if (!finished) break;
    }
    const traversed = scanned === page.ids.length;
    if (!active && traversed) after = page.after_group_id;
    const [finishedClock] = await inputs.read<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      ctx
    );
    this.requireFuture(horizon, normalizeCounter(finishedClock.now));
    const common = {
      eligible_group_ids: eligible,
      scanned_count: scanned,
      after_group_id: after,
      done: !active && traversed && page.done,
      valid_until_millis: horizon,
      query_count: meter.query_count,
      input_rows: meter.input_rows
    };
    if (
      active &&
      input.active_input &&
      JSON.stringify(active) === JSON.stringify(input.active_input)
    )
      throw new MembershipEvaluationError(
        'RESOURCE_LIMIT',
        'Membership quantum made no input progress'
      );
    if (active)
      return {
        ...common,
        kind: 'INPUT_PENDING',
        active_input: validateMembershipActiveInput(active),
        done: false
      };
    if (!traversed && scanned === 0)
      throw new MembershipEvaluationError(
        'RESOURCE_LIMIT',
        'Insufficient budget for a membership input unit'
      );
    return { ...common, kind: 'PAGE_COMPLETE', active_input: null };
  }
  private requireFuture(horizon: string | null, now: string): void {
    if (horizon !== null && BigInt(horizon) <= BigInt(now))
      throw new MembershipEvaluationError(
        'EXPIRED',
        'Membership validity horizon expired'
      );
  }
  private async step(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    grant: MembershipGrantInput | null,
    identity: MembershipIdentityInput,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    switch (active.stage.kind) {
      case 'LISTS':
        return this.lists(active, plan, input, db, ctx);
      case 'SCALARS': {
        const profile = {
          profile_id: identity.profile_id,
          tdh: membershipInteger(identity.tdh),
          xtdh: Number(identity.xtdh),
          rep: membershipInteger(identity.rep),
          cic: membershipInteger(identity.cic),
          level: getLevelFromScore(membershipInteger(identity.level_raw))
        };
        if (!Number.isFinite(profile.xtdh))
          throw new MembershipEvaluationError(
            'INTEGRITY',
            'Invalid xTDH scalar'
          );
        if (
          [
            isProfileViolatingGroupsProfileCicCriteria,
            isProfileViolatingGroupsProfileRepCriteria,
            isProfileViolatingGroupsProfileLevelCriteria,
            isProfileViolatingGroupsProfileTdhCriteria
          ].some((predicate) => predicate(profile, plan.group))
        )
          return false;
        nextRating(active, 'CIC');
        return null;
      }
      case 'RATING':
        return this.ratings(active, plan, input, db, ctx);
      case 'NFT_REQUIREMENT':
        return this.nftRequirement(active, plan, input, db, ctx);
      case 'NFT_ANY':
        return this.wallets(active, plan, grant, input, db, ctx);
      case 'GRANT_ALL_ANY':
        return this.wallets(active, plan, grant, input, db, ctx);
      case 'GRANT_INCLUDE':
        return this.grant(active, plan, grant, input, db, ctx);
    }
  }
  private async lists(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    const state = active.stage;
    if (state.kind !== 'LISTS') throw new Error('Invalid list state');
    const g = plan.group;
    if (g.profile_group_id !== null || g.excluded_profile_group_id !== null) {
      const rows = await db.listWindow(
        input.profile_id,
        g.id,
        state.after_list_id,
        input.limits.raw_window,
        ctx
      );
      const accepted = rows.slice(0, input.limits.raw_window);
      for (const row of accepted) {
        state.included ||= membershipTruth(row.included);
        state.excluded ||= membershipTruth(row.excluded);
        state.after_list_id = row.list_id;
      }
      if (state.excluded) return false;
      if (state.included && !g.excluded_profile_group_id) return true;
      if (rows.length > input.limits.raw_window) return null;
      if (state.included) return true;
    }
    if (!hasGroupGotAnyNonIdentityConditions(g))
      return !g.profile_group_id && !!g.excluded_profile_group_id;
    active.stage = { kind: 'SCALARS' };
    return null;
  }
  private async ratings(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    const state = active.stage;
    if (state.kind !== 'RATING') throw new Error('Invalid rating state');
    const axis = ratingAxis(plan, state.axis);
    if (axis) {
      const rows = await db.ratings(
        input.profile_id,
        axis,
        state.after,
        input.limits.raw_window,
        ctx
      );
      for (const row of rows.slice(0, input.limits.raw_window)) {
        const outgoing = row.rater_profile_id === input.profile_id;
        const other = axis.incoming
          ? row.rater_profile_id
          : row.matter_target_id;
        if (
          outgoing !== axis.incoming &&
          (axis.user === null || other === axis.user) &&
          (axis.category === null || row.matter_category === axis.category)
        ) {
          state.signed_sum = safeSum(
            state.signed_sum,
            membershipInteger(row.rating)
          );
          state.matching_count = String(
            BigInt(state.matching_count) + BigInt(1)
          );
        }
        state.after = {
          category: row.matter_category,
          other_profile_id: other
        };
      }
      if (rows.length > input.limits.raw_window) return null;
      const g = plan.group;
      if (
        isRatingOutOfBounds({
          min: state.axis === 'CIC' ? g.cic_min : g.rep_min,
          max: state.axis === 'CIC' ? g.cic_max : g.rep_max,
          real: membershipInteger(state.signed_sum),
          minMaxNullMeansNonZeroRequired: true
        })
      )
        return false;
    }
    if (state.axis === 'CIC') nextRating(active, 'REP');
    else nextNft(active, 0, plan);
    return null;
  }
  private async nftRequirement(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    const state = active.stage;
    if (state.kind !== 'NFT_REQUIREMENT') throw new Error('Invalid NFT state');
    const count = plan.token_counts[state.contract_slot];
    const all =
      (plan.group[MEMBERSHIP_MATCH_COLUMNS[state.contract_slot]] ??
        GroupNftOwnershipMatchMode.ALL_TOKENS) ===
      GroupNftOwnershipMatchMode.ALL_TOKENS;
    if (BigInt(state.next_json_index) >= BigInt(count)) {
      if (!all) return false;
      nextNft(active, state.contract_slot + 1, plan);
      return null;
    }
    if (state.current_token === null) {
      const token = await db.jsonToken(
        active.group_id,
        state.contract_slot,
        state.next_json_index,
        ctx
      );
      const valid =
        token?.type === 'STRING' &&
        membershipInteger(token.length) <= 20 &&
        /^(0|-?[1-9][0-9]{0,18})$/.test(token.prefix) &&
        BigInt(token.prefix) >= BigInt('-9223372036854775808') &&
        BigInt(token.prefix) <= BigInt('9223372036854775807');
      if (!valid) {
        if (all) return false;
        state.next_json_index = String(
          BigInt(state.next_json_index) + BigInt(1)
        );
        return null;
      }
      state.current_token = token.prefix;
    }
    const rows = await db.owners(
      state.current_token,
      contracts[state.contract_slot],
      state.after_owner_wallet,
      input.limits.raw_window,
      input.profile_id,
      input.identity_consolidation_key,
      ctx
    );
    const accepted = rows.slice(0, input.limits.raw_window);
    if (accepted.some((r) => r.matched !== null)) {
      if (!all) {
        nextNft(active, state.contract_slot + 1, plan);
        return null;
      }
      state.next_json_index = String(BigInt(state.next_json_index) + BigInt(1));
      state.current_token = null;
      state.after_owner_wallet = null;
      return null;
    }
    if (rows.length <= input.limits.raw_window) {
      if (all) return false;
      state.next_json_index = String(BigInt(state.next_json_index) + BigInt(1));
      state.current_token = null;
      state.after_owner_wallet = null;
      return null;
    }
    state.after_owner_wallet = accepted[accepted.length - 1].wallet;
    return null;
  }
  private async wallets(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    grant: MembershipGrantInput | null,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    const state = active.stage;
    if (state.kind !== 'NFT_ANY' && state.kind !== 'GRANT_ALL_ANY')
      throw new Error('Invalid wallet state');
    const external = state.kind === 'GRANT_ALL_ANY';
    if (
      external &&
      (!grant || grant.status !== 'GRANTED' || grant.token_mode !== 'ALL')
    )
      return false;
    const contract =
      state.kind === 'NFT_ANY'
        ? contracts[state.contract_slot]
        : grant!.target_partition;
    const rows = await db.wallets(
      input.identity_consolidation_key,
      state.wallets.after_wallet,
      input.limits.raw_window,
      ctx
    );
    const accepted = rows.slice(0, input.limits.raw_window);
    if (
      await db.walletWitness(
        accepted.map((r) => r.address),
        contract,
        external,
        ctx
      )
    ) {
      if (state.kind === 'GRANT_ALL_ANY') return true;
      nextNft(active, state.contract_slot + 1, plan);
      return null;
    }
    if (rows.length <= input.limits.raw_window) return false;
    state.wallets.after_wallet = accepted[accepted.length - 1].address;
    return null;
  }
  private async grant(
    active: ActiveInputV1,
    plan: MembershipGroupInput,
    grant: MembershipGrantInput | null,
    input: MembershipEvaluationQuantumInput,
    db: MembershipEvaluationInputsDb,
    ctx: MembershipPrimaryContext
  ): Promise<boolean | null> {
    const state = active.stage;
    if (state.kind !== 'GRANT_INCLUDE') throw new Error('Invalid grant state');
    if (!plan.group.is_beneficiary_of_grant_id) return true;
    if (!grant || grant.status !== 'GRANTED') return false;
    const all =
      plan.group.is_beneficiary_of_grant_match_mode ===
      GroupBeneficiaryGrantMatchMode.ALL_TOKENS;
    if (grant.token_mode === 'ALL') {
      if (all) return false;
      active.stage = { kind: 'GRANT_ALL_ANY', wallets: { after_wallet: null } };
      return null;
    }
    if (grant.token_mode !== 'INCLUDE' || grant.tokenset_id === null)
      return false;
    const rows = await db.grantTokens(
      grant,
      state.after_token_id,
      input.limits.raw_window,
      input.profile_id,
      input.identity_consolidation_key,
      ctx
    );
    for (const row of rows.slice(0, input.limits.raw_window)) {
      state.after_token_id = row.token_id;
      if (!membershipTruth(row.selected)) continue;
      state.selected_count = String(BigInt(state.selected_count) + BigInt(1));
      if (row.matched !== null) {
        state.owned_count = String(BigInt(state.owned_count) + BigInt(1));
        if (!all) return true;
      } else if (all) return false;
    }
    if (rows.length > input.limits.raw_window) return null;
    return (
      BigInt(state.selected_count) > BigInt(0) &&
      state.owned_count === state.selected_count
    );
  }
}
