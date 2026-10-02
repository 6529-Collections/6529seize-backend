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
});
