import {
  anonymousOnlyOwnWaveSql,
  followerAudienceConditionSql,
  ungroupedFollowerAudienceSql
} from './ws-audience';

const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('anonymous sockets in public wave audiences', () => {
  it('lets anonymous sockets through only for their subscribed or open wave', () => {
    expect(flat(anonymousOnlyOwnWaveSql('ws', ':waveId', ':anon'))).toBe(
      '(ws.identity_id <> :anon or ws.wave_id = :waveId or ws.open_wave_id = :waveId)'
    );
  });

  it('keeps no unsubscribed sockets in all mode', () => {
    const sql = flat(
      ungroupedFollowerAudienceSql({
        table: 'ws_connections',
        purposeFilter: '1 = 1',
        mode: 'all'
      })
    );
    expect(sql).toContain('where ws.wave_id is null and (1 = 0) and 1 = 1');
    expect(sql).not.toContain('identity_id = :audienceAnonymous');
  });

  it('keeps only signed-in current builds unnarrowed in legacy-clients mode', () => {
    const sql = flat(
      ungroupedFollowerAudienceSql({
        table: 'ws_connections',
        purposeFilter: '1 = 1',
        mode: 'legacy-clients'
      })
    );
    expect(sql).toContain(
      'where ws.wave_id is null and (ws.client_version is not null and ws.identity_id <> :audienceAnonymous)'
    );
    expect(sql).not.toContain('identity_id = :audienceAnonymous');
  });

  it('applies the same rule inside group audiences', () => {
    expect(flat(followerAudienceConditionSql('legacy-clients', 'c'))).toContain(
      '((c.client_version is not null and c.identity_id <> :audienceAnonymous) or c.wave_id = :audienceWaveId'
    );
  });
});
