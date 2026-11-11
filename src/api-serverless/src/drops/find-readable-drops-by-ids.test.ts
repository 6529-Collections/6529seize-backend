import { AuthenticationContext } from '@/auth-context';
import { Logger } from '@/logging';
import { DropsApiService } from './drops.api.service';

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
