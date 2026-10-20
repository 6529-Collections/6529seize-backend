import {
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

describe('frozen GET query routing', () => {
  it('keeps baselines and mutations on the authoritative source', () => {
    expect(legacyCompetitionGetSql('select * from drops')).toBe(
      'select * from drops'
    );
    expect(
      withLegacyCompetitionGetFacade(() =>
        legacyCompetitionGetSql('update drops set title=:title')
      )
    ).toBe('update drops set title=:title');
    expect(
      withLegacyCompetitionGetFacade(() =>
        withoutLegacyCompetitionGetFacade(() =>
          legacyCompetitionGetSql('select * from drops')
        )
      )
    ).toBe('select * from drops');
  });
  it('preserves literals, aliases, implicit qualifiers and nested selects', () => {
    const source =
      "select drops.id, 'from drops', d.title from drops join drops d on d.id=drops.id where exists(select 1 from waves w where w.id=d.wave_id) /* from waves */";
    expect(
      withLegacyCompetitionGetFacade(() => legacyCompetitionGetSql(source))
    ).toBe(
      "select drops.id, 'from drops', d.title from `legacy_get_drops` as `drops` join `legacy_get_drops` d on d.id=drops.id where exists(select 1 from `legacy_get_waves` w where w.id=d.wave_id) /* from waves */"
    );
  });
  it('preserves quoted aliases and comma joins, and drops unsupported view index hints', () => {
    const source =
      'select d.id,w.name from drops `d` FORCE INDEX (PRIMARY), waves w where d.wave_id=w.id';
    const result = withLegacyCompetitionGetFacade(() =>
      legacyCompetitionGetSql(source)
    );
    expect(result).toContain('from `legacy_get_drops` `d`');
    expect(result).toContain(', `legacy_get_waves` w');
    expect(result).not.toContain('FORCE INDEX');
  });
  it('routes CTE reads while leaving CTE mutations untouched', () => {
    expect(
      withLegacyCompetitionGetFacade(() =>
        legacyCompetitionGetSql(
          'with recent as (select * from drops) select * from recent'
        )
      )
    ).toContain('from `legacy_get_drops`');
    expect(
      withLegacyCompetitionGetFacade(() =>
        legacyCompetitionGetSql(
          'with recent as (select * from drops) delete from drops where id in (select id from recent)'
        )
      )
    ).toBe(
      'with recent as (select * from drops) delete from drops where id in (select id from recent)'
    );
  });
  it('isolates overlapping async requests', async () => {
    const results = await Promise.all([
      withLegacyCompetitionGetFacade(async () => {
        await Promise.resolve();
        return legacyCompetitionGetSql('select * from drops');
      }),
      withoutLegacyCompetitionGetFacade(async () => {
        await Promise.resolve();
        return legacyCompetitionGetSql('select * from drops');
      })
    ]);
    expect(results).toEqual([
      'select * from `legacy_get_drops` as `drops`',
      'select * from drops'
    ]);
  });
  it('leaves unrelated GET repository tables untouched', () => {
    const query =
      'select n.id,p.handle from nfts n join profiles p on p.id=n.id';
    expect(
      withLegacyCompetitionGetFacade(() => legacyCompetitionGetSql(query))
    ).toBe(query);
  });
  it('returns the callback result synchronously and preserves thrown errors', () => {
    expect(withLegacyCompetitionGetFacade(() => 42)).toBe(42);
    const error = new Error('route failure');
    expect(() =>
      withLegacyCompetitionGetFacade(() => {
        throw error;
      })
    ).toThrow(error);
  });
});

// This guard checks generated SQL itself rather than a mock table inventory:
// compatibility installation must work after physical retirement as well.
describe('native-only permanent compatibility definitions', () => {
  it('never discovers columns or falls back to retired physical sources', async () => {
    const { LEGACY_GET_SOURCE_TABLES, legacyCompetitionGetViewDefinition } =
      await import('./legacy-competition-get-facade');
    for (const table of LEGACY_GET_SOURCE_TABLES) {
      const sql = legacyCompetitionGetViewDefinition(table);
      expect(sql).not.toMatch(
        /information_schema|competition_migrations|competition_legacy_mirror_permits|union all/i
      );
      if (table !== 'waves' && table !== 'drops') {
        for (const source of LEGACY_GET_SOURCE_TABLES.filter(
          (source) => source !== 'waves' && source !== 'drops'
        )) {
          expect(sql).not.toMatch(
            new RegExp(`(?:from|join) ${source}\\b`, 'i')
          );
        }
      }
    }
  });

  it('uses immutable original-primary ownership, independent of default selection', async () => {
    const { legacyCompetitionGetViewDefinition } =
      await import('./legacy-competition-get-facade');
    for (const table of [
      'waves',
      'drops',
      'drop_voter_states',
      'wave_decisions'
    ]) {
      const sql = legacyCompetitionGetViewDefinition(table);
      expect(sql).toContain('c.legacy_wave_id=c.wave_id');
      expect(sql).not.toContain('default_competition');
    }
    const wave = legacyCompetitionGetViewDefinition('waves');
    expect(wave).not.toMatch(
      /w\.`(?:voting_|participation_|winning_|type|next_decision_time|time_lock_ms)/
    );
  });
});
