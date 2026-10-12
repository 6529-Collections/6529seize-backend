import fc from 'fast-check';
import { DropType } from '@/entities/IDrop';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { BadRequestException } from '@/exceptions';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';

type QuotedDropEntity = { id: string; wave_id: string; parts_count: number };

function createUseCase({
  quotedDrops,
  readableWaveIds,
  proxyCanReadWaves = false
}: {
  quotedDrops: QuotedDropEntity[];
  readableWaveIds: string[];
  proxyCanReadWaves?: boolean;
}) {
  const dropsDb = {
    getDropsByIds: jest.fn(async (ids: string[]) =>
      quotedDrops.filter((drop) => ids.includes(drop.id))
    )
  };
  const wavesApiDb = {
    findWavesByIdsEligibleForRead: jest.fn(
      async (waveIds: string[], groupIds: string[]) =>
        waveIds
          .filter(
            (waveId) =>
              readableWaveIds.includes(waveId) &&
              (groupIds.length > 0 || waveId.startsWith('public'))
          )
          .map((id) => ({ id }))
    )
  };
  const proxyService = {
    hasActiveProxyAction: jest.fn().mockResolvedValue(proxyCanReadWaves)
  };
  const useCase = new CreateOrUpdateDropUseCase(
    dropsDb as any,
    {} as any,
    {} as any,
    wavesApiDb as any,
    {} as any,
    {} as any,
    {} as any,
    proxyService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      evaluate: jest.fn(),
      assertPostingAllowed: jest.fn()
    }
  );
  return { useCase, dropsDb, wavesApiDb, proxyService };
}

function aModel(
  quotes: { drop_id: string; drop_part_id: number }[],
  overrides: Record<string, unknown> = {}
) {
  return {
    author_identity: 'author-1',
    author_id: 'author-1',
    drop_id: null,
    drop_type: DropType.CHAT,
    wave_id: 'target-wave',
    reply_to: null,
    title: null,
    parts: quotes.map((quote) => ({
      content: 'quote',
      media: [],
      quoted_drop: quote
    })),
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_waves: [],
    mentioned_groups: [],
    metadata: [],
    signature: null,
    ...overrides
  };
}

async function verify(
  useCase: CreateOrUpdateDropUseCase,
  model: ReturnType<typeof aModel>,
  groupIdsUserIsEligibleFor: string[] = ['author-group']
) {
  await (useCase as any).verifyQuotedDrops(
    { model, groupIdsUserIsEligibleFor },
    { connection: {} }
  );
}

describe('CreateOrUpdateDropUseCase.verifyQuotedDrops', () => {
  it('accepts quotes of drops in waves the author can read', async () => {
    const { useCase, wavesApiDb } = createUseCase({
      quotedDrops: [{ id: 'quoted', wave_id: 'private-wave', parts_count: 2 }],
      readableWaveIds: ['private-wave']
    });

    await expect(
      verify(useCase, aModel([{ drop_id: 'quoted', drop_part_id: 2 }]))
    ).resolves.toBeUndefined();
    expect(wavesApiDb.findWavesByIdsEligibleForRead).toHaveBeenCalledWith(
      ['private-wave'],
      ['author-group'],
      {}
    );
  });

  it('rejects quotes of drops in waves the author cannot read', async () => {
    const { useCase } = createUseCase({
      quotedDrops: [{ id: 'quoted', wave_id: 'private-wave', parts_count: 1 }],
      readableWaveIds: []
    });

    await expect(
      verify(useCase, aModel([{ drop_id: 'quoted', drop_part_id: 1 }]))
    ).rejects.toThrow(
      new BadRequestException('Invalid quoted drops: quoted/1')
    );
  });

  it('uses the same response for missing and unreadable quoted drops', async () => {
    const { useCase } = createUseCase({
      quotedDrops: [{ id: 'hidden', wave_id: 'private-wave', parts_count: 1 }],
      readableWaveIds: []
    });

    const errors = await Promise.all(
      ['hidden', 'missing'].map((dropId) =>
        verify(useCase, aModel([{ drop_id: dropId, drop_part_id: 1 }])).catch(
          (error: Error) => error
        )
      )
    );

    expect(errors.map((error) => (error as Error).constructor)).toEqual([
      BadRequestException,
      BadRequestException
    ]);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'Invalid quoted drops: hidden/1',
      'Invalid quoted drops: missing/1'
    ]);
  });

  it('applies the read check to non-chat drop types that can carry quotes', async () => {
    const { useCase } = createUseCase({
      quotedDrops: [{ id: 'quoted', wave_id: 'private-wave', parts_count: 1 }],
      readableWaveIds: []
    });

    await expect(
      verify(
        useCase,
        aModel([{ drop_id: 'quoted', drop_part_id: 1 }], {
          drop_type: DropType.WINNER
        })
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('reads as anonymous for a proxy without the read waves action', async () => {
    const { useCase, wavesApiDb, proxyService } = createUseCase({
      quotedDrops: [{ id: 'quoted', wave_id: 'private-wave', parts_count: 1 }],
      readableWaveIds: ['private-wave'],
      proxyCanReadWaves: false
    });

    await expect(
      verify(
        useCase,
        aModel([{ drop_id: 'quoted', drop_part_id: 1 }], {
          proxy_id: 'proxy-1'
        })
      )
    ).rejects.toThrow(BadRequestException);
    expect(proxyService.hasActiveProxyAction).toHaveBeenCalledWith({
      granted_by_profile_id: 'author-1',
      granted_to_profile_id: 'proxy-1',
      action: ProfileProxyActionType.READ_WAVE
    });
    expect(wavesApiDb.findWavesByIdsEligibleForRead).toHaveBeenCalledWith(
      ['private-wave'],
      [],
      {}
    );
  });

  it("reads with the author's groups for a proxy with the read waves action", async () => {
    const { useCase } = createUseCase({
      quotedDrops: [{ id: 'quoted', wave_id: 'private-wave', parts_count: 1 }],
      readableWaveIds: ['private-wave'],
      proxyCanReadWaves: true
    });

    await expect(
      verify(
        useCase,
        aModel([{ drop_id: 'quoted', drop_part_id: 1 }], {
          proxy_id: 'proxy-1'
        })
      )
    ).resolves.toBeUndefined();
  });

  it('accepts a quote set exactly when every quoted wave is readable', async () => {
    const waveIds = ['wave-a', 'wave-b', 'wave-c'];
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(waveIds),
        fc.subarray(waveIds, { minLength: 1 }),
        async (readableWaveIds, quotedWaveIds) => {
          const quotedDrops = quotedWaveIds.map((waveId) => ({
            id: `drop-in-${waveId}`,
            wave_id: waveId,
            parts_count: 1
          }));
          const { useCase } = createUseCase({ quotedDrops, readableWaveIds });
          const model = aModel(
            quotedDrops.map((drop) => ({ drop_id: drop.id, drop_part_id: 1 }))
          );
          const accepted = await verify(useCase, model).then(
            () => true,
            () => false
          );
          expect(accepted).toBe(
            quotedWaveIds.every((waveId) => readableWaveIds.includes(waveId))
          );
        }
      )
    );
  });
});
