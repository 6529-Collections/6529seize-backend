import { CompetitionCursorCodec } from '@/competitions/competition-cursor';

describe('CompetitionCursorCodec', () => {
  const codec = new CompetitionCursorCodec();

  it('round trips an offset bound to resource, filters and ordering', () => {
    const cursor = codec.encode(
      'entries:wave-a:competition-a',
      {
        status: ['ACTIVE'],
        direction: 'ASC'
      },
      20
    );
    expect(
      codec.decode(cursor, 'entries:wave-a:competition-a', {
        status: ['ACTIVE'],
        direction: 'ASC'
      })
    ).toBe(20);
  });

  it('rejects pre-cutover winner cursors after changing to win-time ordering', () => {
    const old = codec.encode(
      'competition:a:winners',
      { direction: 'ASC', sort: null },
      50
    );
    expect(() =>
      codec.decode(old, 'competition:a:winners', {
        direction: 'ASC',
        sort: 'won_at'
      })
    ).toThrow('Invalid competition cursor');
    expect(() =>
      codec.decode(old, 'competition:a:winners', {
        direction: 'DESC',
        sort: 'won_at'
      })
    ).toThrow('Invalid competition cursor');
  });

  it('rejects reuse with different filters or resources', () => {
    const cursor = codec.encode('entries:a', { direction: 'ASC' }, 20);
    expect(() =>
      codec.decode(cursor, 'entries:a', { direction: 'DESC' })
    ).toThrow('Invalid competition cursor');
    expect(() =>
      codec.decode(cursor, 'entries:b', { direction: 'ASC' })
    ).toThrow('Invalid competition cursor');
  });
});
