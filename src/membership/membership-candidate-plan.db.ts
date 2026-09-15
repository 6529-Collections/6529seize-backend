import { PROFILE_GROUPS_TABLE, USER_GROUPS_TABLE } from '@/constants';
import type { MembershipPrimaryContext } from '@/membership/membership-primary';
import type { MembershipProfilePageInput } from '@/membership/membership-evaluator.types';
import { membershipTruth } from '@/membership/membership-evaluation-validation';
import { MembershipEvaluationInputsDb } from '@/membership/membership-evaluation-inputs.db';

export interface MembershipCandidatePage {
  ids: string[];
  after_group_id: string | null;
  done: boolean;
}
/** Sparse proof is bounded before eligibility/reference filters; dense profiles use a raw PK page. */
export class MembershipCandidatePlanDb {
  constructor(private readonly inputs: MembershipEvaluationInputsDb) {}
  async page(
    input: MembershipProfilePageInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipCandidatePage> {
    if (input.through_group_id === null)
      return { ids: [], after_group_id: input.after_group_id, done: true };
    const profileIndex = await this.inputs.index(
      PROFILE_GROUPS_TABLE,
      ['profile_id'],
      ctx
    );
    const lists = await this.inputs.read<{ profile_group_id: string }>(
      `SELECT pg.profile_group_id FROM ${PROFILE_GROUPS_TABLE} pg FORCE INDEX(${profileIndex}) WHERE pg.profile_id=:profile ORDER BY pg.profile_group_id LIMIT 9`,
      { profile: input.profile_id },
      ctx
    );
    if (lists.length > 8) return this.raw(input, ctx);
    const referencesIndex = await this.inputs.index(
      USER_GROUPS_TABLE,
      ['profile_group_id', 'visible', 'id'],
      ctx
    );
    const pure = new Set<string>();
    for (const list of lists) {
      const rows = await this.inputs.read<{ id: string; pure: unknown }>(
        `SELECT g.id,g.is_pure_profile_group pure FROM ${USER_GROUPS_TABLE} g FORCE INDEX(${referencesIndex}) WHERE g.profile_group_id=:list AND g.visible=1 ${input.after_group_id === null ? '' : 'AND g.id>:after'} AND g.id<=:through ORDER BY g.id LIMIT 9`,
        {
          list: list.profile_group_id,
          after: input.after_group_id,
          through: input.through_group_id
        },
        ctx
      );
      if (rows.length > 8) return this.raw(input, ctx);
      for (const row of rows) if (membershipTruth(row.pure)) pure.add(row.id);
    }
    const broad = await this.inputs.read<{ id: string }>(
      `SELECT g.id FROM ${USER_GROUPS_TABLE} g FORCE INDEX(idx_user_groups_pure_visible_id) WHERE g.is_pure_profile_group=0 AND g.visible=1 ${input.after_group_id === null ? '' : 'AND g.id>:after'} AND g.id<=:through ORDER BY g.id LIMIT :limit`,
      {
        after: input.after_group_id,
        through: input.through_group_id,
        limit: input.max_scanned_groups + 1
      },
      ctx
    );
    const more = broad.length > input.max_scanned_groups;
    const bound = more
      ? broad[input.max_scanned_groups - 1].id
      : input.through_group_id;
    const ids = Array.from(
      new Set([
        ...Array.from(pure),
        ...broad.slice(0, input.max_scanned_groups).map((r) => r.id)
      ])
    );
    if (!ids.length) return { ids: [], after_group_id: bound, done: !more };
    const ordered = await this.inputs.read<{ id: string }>(
      `SELECT g.id FROM ${USER_GROUPS_TABLE} g FORCE INDEX(PRIMARY) WHERE g.id IN (:ids) ${input.after_group_id === null ? '' : 'AND g.id>:after'} AND g.id<=:bound ORDER BY g.id LIMIT :limit`,
      {
        ids,
        after: input.after_group_id,
        bound,
        limit: input.max_scanned_groups + 1
      },
      ctx
    );
    if (ordered.length > input.max_scanned_groups)
      return {
        ids: ordered.slice(0, input.max_scanned_groups).map((r) => r.id),
        after_group_id: ordered[input.max_scanned_groups - 1].id,
        done: false
      };
    return {
      ids: ordered.map((r) => r.id),
      after_group_id: bound,
      done: !more
    };
  }
  private async raw(
    input: MembershipProfilePageInput,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipCandidatePage> {
    const rows = await this.inputs.read<{ id: string }>(
      `SELECT g.id FROM ${USER_GROUPS_TABLE} g FORCE INDEX(PRIMARY) WHERE ${input.after_group_id === null ? 'TRUE' : 'g.id>:after'} AND g.id<=:through ORDER BY g.id LIMIT :limit`,
      {
        after: input.after_group_id,
        through: input.through_group_id,
        limit: input.max_scanned_groups + 1
      },
      ctx
    );
    const more = rows.length > input.max_scanned_groups;
    const accepted = rows.slice(0, input.max_scanned_groups);
    return {
      ids: accepted.map((r) => r.id),
      after_group_id: more
        ? accepted[accepted.length - 1].id
        : input.through_group_id,
      done: !more
    };
  }
}
