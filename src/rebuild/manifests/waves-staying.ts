import { PlannedRows } from '@/rebuild/manifest.types';

/**
 * The rows of waves and groups that stay on 6529.io, in the tables the
 * chain mirror writes: the mirror can't bring them back until private
 * waves exist on the chain, so each table gets a plan for them.
 *
 * A wave stays unless the chain holds it: after the switch-on a wave has
 * moved when the chain index holds a LegacyId for it (compared without
 * dashes or case), or when it was made on the chain (a 0x id). That
 * covers members-only, direct-message and records waves, waves using a
 * hidden or private group, their subwaves, and any wave the import didn't
 * carry. A decision and its rows follow their wave.
 *
 * A group stays when the Waves v1 file never held it: no moved wave names
 * it as its read, post or admin group and no decision of a moved wave
 * names it as its submit or vote group (the snapshot tool keeps exactly
 * the groups those name, and refuses a hidden or private one among them).
 * A group the mirror's own match table matches to a chain group has moved
 * too: that can only shrink what is excused, never hide a group the
 * mirror failed to match. A group made on the chain is the mirror's.
 */
export const STAYING_REASON =
  "Stays on 6529.io: members-only, direct-message or records waves, waves using a hidden or private group, their subwaves and waves the chain doesn't hold, and groups no wave or decision on the chain names, until private waves exist on the chain";

export const STAYING_UNTIL = '2026-12-15';

export const STAYING_CHANGE = 'private groups and waves on the 6529 chain';

/** The waves row or reference in `column` is a wave the chain holds. */
function movedWave(column: string): string {
  return `exists (select 1 from chain_waves cw where cw.legacy_id is not null and replace(lower(cw.legacy_id), '-', '') = replace(lower(${column}), '-', ''))`;
}

/** The wave in `column` stays on 6529.io. */
export function stayingWave(column: string): string {
  return `(${column} not like '0x%' and not ${movedWave(column)})`;
}

/** The community_groups row aliased `alias` stays on 6529.io. */
export function stayingGroup(alias: string): string {
  const id = `${alias}.id`;
  const moved = [
    `exists (select 1 from waves mw where ${movedWave('mw.id')} and ${id} in (mw.visibility_group_id, mw.chat_group_id, mw.admin_group_id))`,
    `exists (select 1 from competitions md where ${movedWave('md.wave_id')} and ${id} in (json_unquote(json_extract(md.participation_config, '$.group_id')), json_unquote(json_extract(md.voting_config, '$.group_id'))))`,
    `exists (select 1 from waves_chain_mirror_groups mg where mg.group_id = ${id})`
  ];
  return `(${id} not like '0x%' and not (${moved.join(' or ')}))`;
}

const STAYING_COMPETITION = `competition_id in (select d.id from competitions d where ${stayingWave('d.wave_id')})`;

/** Each table's staying rows. */
export const STAYING_WHERE: Readonly<Record<string, string>> = {
  waves: stayingWave('waves.id'),
  waves_metadatas: stayingWave('waves_metadatas.wave_id'),
  // For when the mirror's writes take these tables back.
  waves_archive: stayingWave('waves_archive.id'),
  drops: stayingWave('drops.wave_id'),
  drops_parts: `drops_parts.drop_id in (select dr.id from drops dr where ${stayingWave('dr.wave_id')})`,
  community_groups: stayingGroup('community_groups'),
  profile_groups: `profile_groups.profile_group_id in (select g.profile_group_id from community_groups g where ${stayingGroup('g')} union select g.excluded_profile_group_id from community_groups g where ${stayingGroup('g')})`,
  competitions: stayingWave('competitions.wave_id'),
  competition_config_versions: STAYING_COMPETITION,
  competition_capabilities: STAYING_COMPETITION,
  competition_outcomes: STAYING_COMPETITION,
  competition_outcome_distribution_items: STAYING_COMPETITION,
  competition_lifecycle_events: STAYING_COMPETITION,
  competition_entries: STAYING_COMPETITION,
  competition_votes: STAYING_COMPETITION,
  competition_entry_runtime: STAYING_COMPETITION,
  competition_leaderboard_entries: STAYING_COMPETITION,
  competition_decisions: STAYING_COMPETITION,
  competition_decision_winners: STAYING_COMPETITION,
  competition_winner_votes: STAYING_COMPETITION,
  competition_outcome_awards: STAYING_COMPETITION,
  competition_vote_history: STAYING_COMPETITION,
  competition_score_history: STAYING_COMPETITION
};

/** One plan for each table in `writes` that can hold staying rows. */
export function stayingWavesPlans(writes: readonly string[]): PlannedRows[] {
  return writes
    .filter((table) => table in STAYING_WHERE)
    .map((table) => ({
      table,
      where: STAYING_WHERE[table],
      reason: STAYING_REASON,
      until: STAYING_UNTIL,
      change: STAYING_CHANGE
    }));
}
