import { WAVES_TABLE } from '@/constants';

// Arguments are repository-owned SQL expressions/parameter names, never request
// values. Keep parent checks at the query boundary, including aggregate queries.
export function waveReadAccessSql(
  waveAlias: string,
  hasEligibleGroups: boolean,
  groupIdsParam = 'eligibleGroupIds'
): string {
  const visible = (alias: string) =>
    `(${alias}.visibility_group_id is null${hasEligibleGroups ? ` or ${alias}.visibility_group_id in (:${groupIdsParam})` : ''})`;
  return `(${visible(waveAlias)} and (
    ${waveAlias}.parent_wave_id is null or exists (
      select 1 from ${WAVES_TABLE} access_parent
      where access_parent.id = ${waveAlias}.parent_wave_id
        and access_parent.parent_wave_id is null
        and ${visible('access_parent')}
    )
  ))`;
}

export function optionalWaveReadAccessSql(
  waveIdSql: string,
  hasEligibleGroups: boolean,
  groupIdsParam = 'eligibleGroupIds'
): string {
  return `(${waveIdSql} is null or exists (
    select 1 from ${WAVES_TABLE} access_wave
    where access_wave.id = ${waveIdSql}
      and ${waveReadAccessSql('access_wave', hasEligibleGroups, groupIdsParam)}
  ))`;
}
