import { DROPS_TABLE } from '@/constants/db-tables';
import { legacyCompetitionGetViewDefinition } from '@/competitions/legacy-competition-get-facade';
import { VIEW_MAPPED_ENTRY_STATUSES } from '@/competitions/legacy-typed-drops';

/**
 * The base-table replacements in legacy-typed-drops.ts restate the drops
 * view's typing rule. This pins the rule they restate to the view's actual
 * definition, so a change to the view's drop_type CASE fails here instead of
 * letting the replacements drift from it.
 */
describe('legacy typed drops follow the drops view typing', () => {
  const view = legacyCompetitionGetViewDefinition(DROPS_TABLE);

  it('maps entry statuses exactly as the replacements assume', () => {
    expect(view).toContain(
      `case when e.status='WINNER' then 'WINNER' when e.status='ACTIVE' then 'PARTICIPATORY' when e.status in ('WITHDRAWN','DISQUALIFIED') or d.drop_type='COMPETITION' then 'CHAT' else d.drop_type end as drop_type`
    );
  });

  it('maps exactly the statuses the replacements treat as view-mapped', () => {
    const typing = /case when e\.status=.* end as drop_type/.exec(view)?.[0];
    expect(typing).toBeDefined();
    const statusesInView = new Set(
      Array.from(
        typing!.matchAll(/e\.status(?:=| in \()([^)]*?)(?:\)| then)/g),
        (match) => match[1]
      ).flatMap((list) =>
        list
          .split(',')
          .map((status) => status.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
      )
    );
    const assumed = new Set(
      VIEW_MAPPED_ENTRY_STATUSES.split(',').map((status) =>
        status.trim().replace(/^'|'$/g, '')
      )
    );
    expect(statusesInView).toEqual(assumed);
  });

  it('joins entries only through the native primary competition', () => {
    expect(view).toContain(
      'left join competitions c on c.legacy_wave_id=d.wave_id and c.legacy_wave_id=c.wave_id'
    );
    expect(view).toContain(
      'left join competition_entries e on e.competition_id=c.id and e.drop_id=d.id'
    );
  });
});
