import * as fc from 'fast-check';
import { AuthenticationContext } from '@/auth-context';
import { Logger } from '@/logging';
import {
  DropsApiService,
  ONE_BY_ONE_DROP_MAPPING_BUDGET_MS
} from './drops.api.service';

function aDrop(id: string) {
  return { id, wave_id: 'wave-1' };
}

function createService(
  entities: Array<{ id: string }>,
  convertToDropFulls: jest.Mock
) {
  const dropsDb = {
    findDropsByIdsWithEligibilityCheck: jest.fn().mockResolvedValue(entities)
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group-1'])
  };
  const service = new DropsApiService(
    { convertToDropFulls } as any,
    dropsDb as any,
    {} as any,
    userGroupsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, dropsDb };
}

const ctx = {
  authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
  timer: undefined
} as any;

/** Maps every drop except those named in `broken`, like the real mapper. */
function mapperFailingOn(...broken: string[]) {
  return jest.fn(async ({ dropEntities }: { dropEntities: any[] }) => {
    if (dropEntities.some((it) => broken.includes(it.id))) {
      throw new Error('mapper failure');
    }
    return dropEntities.map((it) => ({ id: it.id, mapped: true }));
  });
}

describe('DropsApiService.findReadableDropsByIds', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps the readable drops in one call with the caller eligibility', async () => {
    const convert = mapperFailingOn();
    const { service, dropsDb } = createService(
      [aDrop('a'), aDrop('b')],
      convert
    );

    await expect(
      service.findReadableDropsByIds(['a', 'b', 'c'], ctx)
    ).resolves.toEqual([
      { id: 'a', mapped: true },
      { id: 'b', mapped: true }
    ]);
    expect(dropsDb.findDropsByIdsWithEligibilityCheck).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      ['group-1'],
      undefined
    );
    expect(convert).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('leaves out a drop the mapper cannot handle and returns the rest', async () => {
    const convert = mapperFailingOn('b');
    const { service } = createService(
      [aDrop('a'), aDrop('b'), aDrop('c')],
      convert
    );

    await expect(
      service.findReadableDropsByIds(['a', 'b', 'c'], ctx)
    ).resolves.toEqual([
      { id: 'a', mapped: true },
      { id: 'c', mapped: true }
    ]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0][0])).toContain(
      'left out 1 that could not be mapped'
    );
  });

  describe('after a failed bulk mapping', () => {
    let nowMs: number;

    beforeEach(() => {
      nowMs = Date.UTC(2026, 10, 12);
      jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    });

    /** Like mapperFailingOn, but every call takes `callMs`. */
    function slowMapperFailingOn(callMs: number, ...broken: string[]) {
      const fast = mapperFailingOn(...broken);
      return jest.fn(async (args: { dropEntities: any[] }) => {
        nowMs += callMs;
        return fast(args);
      });
    }

    it('stops mapping one by one when the time budget is spent and leaves the rest out', async () => {
      const callMs = ONE_BY_ONE_DROP_MAPPING_BUDGET_MS / 3;
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      const convert = slowMapperFailingOn(callMs, 'b');
      const { service } = createService(ids.map(aDrop), convert);

      await expect(service.findReadableDropsByIds(ids, ctx)).resolves.toEqual([
        { id: 'a', mapped: true },
        { id: 'c', mapped: true }
      ]);
      // The failed bulk call, then a, b and c; d, e and f are not tried.
      expect(convert).toHaveBeenCalledTimes(4);
      expect(String(logError.mock.calls[0][0])).toContain(
        'left out 1 that could not be mapped and 3 not tried'
      );
    });

    it('never runs one-by-one mapping for longer than the budget plus one call', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 1, max: 2 * ONE_BY_ONE_DROP_MAPPING_BUDGET_MS }),
          async (count, callMs) => {
            const ids = Array.from({ length: count }, (_, i) => `drop-${i}`);
            const convert = slowMapperFailingOn(callMs, 'drop-0');
            const { service } = createService(ids.map(aDrop), convert);
            const fallbackStartMs = nowMs + callMs;

            const result = await service
              .findReadableDropsByIds(ids, ctx)
              .catch(() => []);

            expect(nowMs - fallbackStartMs).toBeLessThan(
              ONE_BY_ONE_DROP_MAPPING_BUDGET_MS + callMs
            );
            const resultIds = result.map((drop) => drop.id);
            expect(resultIds).toEqual(
              ids.filter((id) => resultIds.includes(id))
            );
            expect(resultIds).not.toContain('drop-0');
          }
        )
      );
    });

    it('maps every drop when the calls fit in the budget', async () => {
      const ids = ['a', 'b', 'c'];
      const convert = slowMapperFailingOn(1, 'b');
      const { service } = createService(ids.map(aDrop), convert);

      await expect(service.findReadableDropsByIds(ids, ctx)).resolves.toEqual([
        { id: 'a', mapped: true },
        { id: 'c', mapped: true }
      ]);
      expect(String(logError.mock.calls[0][0])).toContain(
        'left out 1 that could not be mapped and 0 not tried'
      );
    });
  });

  it('fails as before when no drop can be mapped', async () => {
    const { service } = createService(
      [aDrop('a'), aDrop('b')],
      mapperFailingOn('a', 'b')
    );

    await expect(
      service.findReadableDropsByIds(['a', 'b'], ctx)
    ).rejects.toThrow('mapper failure');
  });

  it('reads nothing for an empty or fully unreadable list', async () => {
    const convert = mapperFailingOn();
    const { service, dropsDb } = createService([], convert);

    await expect(service.findReadableDropsByIds([], ctx)).resolves.toEqual([]);
    expect(dropsDb.findDropsByIdsWithEligibilityCheck).not.toHaveBeenCalled();
    await expect(service.findReadableDropsByIds(['x'], ctx)).resolves.toEqual(
      []
    );
    expect(convert).not.toHaveBeenCalled();
  });
});
