import { CustomApiCompliantException } from '@/exceptions';
import {
  COMPETITION_PUBLISHED_LIMIT_DEFAULTS,
  CompetitionPublicationCapacity,
  competitionPublishedLimits
} from './competition-publication-capacity';

function capacity(
  counts: { inWave: number; byCreator: number; creator?: string | null },
  limits = { perWave: 3, perCreator: 5 }
) {
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes('select created_by'))
        return counts.creator === undefined
          ? []
          : [{ created_by: counts.creator }];
      if (sql.includes('join'))
        return [{ cnt: String(counts.byCreator), params }];
      return [{ cnt: counts.inWave }];
    }
  );
  const db = {
    execute,
    oneOrNull: async (sql: string, params: Record<string, unknown>) =>
      (await execute(sql, params))[0] ?? null
  };
  return {
    service: new CompetitionPublicationCapacity(
      () => db as never,
      () => limits
    ),
    execute
  };
}

const request = {
  competitionId: 'draft',
  waveId: 'wave',
  actorId: 'publisher'
};

describe('competitionPublishedLimits', () => {
  it('defaults to 25 per wave and 50 per creator', () => {
    expect(COMPETITION_PUBLISHED_LIMIT_DEFAULTS).toEqual({
      perWave: 25,
      perCreator: 50
    });
    expect(competitionPublishedLimits({})).toEqual({
      perWave: 25,
      perCreator: 50
    });
  });

  it('reads whole numbers and ignores anything else', () => {
    expect(
      competitionPublishedLimits({
        COMPETITION_MAX_PUBLISHED_PER_WAVE: '5',
        COMPETITION_MAX_PUBLISHED_PER_CREATOR: 'lots'
      })
    ).toEqual({ perWave: 5, perCreator: 50 });
  });
});

describe('CompetitionPublicationCapacity', () => {
  it('allows publishing below both caps', async () => {
    const { service } = capacity({ inWave: 2, byCreator: 4, creator: 'c' });

    await expect(service.assertCanPublish(request, {})).resolves.toBe(
      undefined
    );
  });

  it('rejects a wave already at its cap with 409', async () => {
    const { service } = capacity({ inWave: 3, byCreator: 0, creator: 'c' });

    const error = await service
      .assertCanPublish(request, {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CustomApiCompliantException);
    expect((error as CustomApiCompliantException).getStatusCode()).toBe(409);
    expect((error as CustomApiCompliantException).code).toBe(
      'PUBLISHED_COMPETITION_LIMIT'
    );
    expect((error as CustomApiCompliantException).details).toEqual({
      limit: 3,
      scope: 'wave'
    });
  });

  it('rejects a creator already at the cap across waves', async () => {
    const { service, execute } = capacity({
      inWave: 0,
      byCreator: 5,
      creator: 'creator'
    });

    await expect(service.assertCanPublish(request, {})).rejects.toMatchObject({
      details: { limit: 5, scope: 'creator' }
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('v.created_by = :creator'),
      expect.objectContaining({ creator: 'creator', published: 'PUBLISHED' })
    );
  });

  it('counts the publishing profile when the creator is unknown', async () => {
    const { service, execute } = capacity({ inWave: 0, byCreator: 0 });

    await service.assertCanPublish(request, {});

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('v.created_by = :creator'),
      expect.objectContaining({ creator: 'publisher' })
    );
  });

  it('skips a cap set to zero', async () => {
    const { service, execute } = capacity(
      { inWave: 100, byCreator: 100, creator: 'c' },
      { perWave: 0, perCreator: 0 }
    );

    await service.assertCanPublish(request, {});

    expect(execute).not.toHaveBeenCalled();
  });

  it('never counts the draft being published', async () => {
    const { service, execute } = capacity({ inWave: 0, byCreator: 0 });

    await service.assertCanPublish(request, {});

    for (const [sql, params] of execute.mock.calls.filter(([sql]) =>
      String(sql).includes('count(*)')
    )) {
      expect(sql).toContain('<> :competitionId');
      expect(params).toMatchObject({ competitionId: 'draft' });
    }
  });
});
