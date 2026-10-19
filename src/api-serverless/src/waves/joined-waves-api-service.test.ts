jest.mock('@/api/waves/waves.api.db', () => ({ wavesApiDb: {} }));
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {}
}));
jest.mock('@/api/waves/api-wave-overview.mapper', () => ({
  apiWaveOverviewMapper: {}
}));
jest.mock('@/redis', () => ({ redisGet: jest.fn(), redisSetJson: jest.fn() }));

import { AuthenticationContext } from '@/auth-context';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { ApiWaveOverviewMapper } from './api-wave-overview.mapper';
import { WavesApiDb } from './waves.api.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WaveEntity } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { JoinedWavesApiService } from './joined-waves.api.service';
import {
  JoinedWaveSnapshot,
  JoinedWaveSnapshotStore,
  decodeJoinedWaveCursor
} from './joined-wave-snapshot';

const snapshotId = '00000000-0000-4000-8000-000000000529';
let ids: string[];
let joined: Set<string>;
let readable: Set<string>;
let saved: JoinedWaveSnapshot;
const findIds = jest.fn();
const findEntities = jest.fn();
const groups = { getGroupsUserIsEligibleFor: jest.fn(async () => ['visible']) };
const snapshots = {
  create: jest.fn(
    async (_profile: string, waveIds: string[], pageSize: number) => {
      saved = {
        id: snapshotId,
        waveIds: [...waveIds],
        pageSize,
        expiresAt: Date.now() + 900000
      };
      return saved;
    }
  ),
  read: jest.fn(async () => saved)
};
const mapper = {
  mapWaves: jest.fn(async (waves: { id: string }[]) =>
    Object.fromEntries(
      waves.map((wave) => [wave.id, { id: wave.id } as ApiWaveOverview])
    )
  )
};
const service = new JoinedWavesApiService(
  {
    findJoinedRootWaveIds: findIds,
    findWavesByIdsEligibleForRead: findEntities
  } as unknown as WavesApiDb,
  groups as unknown as UserGroupsService,
  mapper as unknown as ApiWaveOverviewMapper,
  snapshots as unknown as JoinedWaveSnapshotStore
);
const context = (proxy = false): RequestContext => ({
  authenticationContext: {
    isUserFullyAuthenticated: () => true,
    isAuthenticatedAsProxy: () => proxy,
    getActingAsId: () => 'alice'
  } as unknown as AuthenticationContext
});

beforeEach(() => {
  jest.clearAllMocks();
  ids = Array.from(
    { length: 65 },
    (_, index) => `wave-${String(index).padStart(2, '0')}`
  );
  joined = new Set(ids);
  readable = new Set(ids);
  findIds.mockImplementation(async ({ waveIds }: { waveIds?: string[] }) =>
    (waveIds ?? ids).filter((id) => joined.has(id) && readable.has(id))
  );
  findEntities.mockImplementation(async (waveIds: string[]) =>
    waveIds.map((id) => ({ id }) as WaveEntity)
  );
});

it('returns every joined wave once even when activity order changes across page boundaries', async () => {
  const expected = [...ids];
  let page = await service.findPage({ page_size: 20 }, context());
  const actual = page.data.map((wave) => wave.id);
  ids = [...ids].reverse();
  while (page.next_cursor) {
    page = await service.findPage(
      { page_size: 20, cursor: page.next_cursor },
      context()
    );
    actual.push(...page.data.map((wave) => wave.id));
  }
  expect(actual).toEqual(expected);
  expect(new Set(actual).size).toBe(65);
  expect(snapshots.create).toHaveBeenCalledTimes(1);
});

it('fills pages after unfollows and access loss and advances over removed IDs', async () => {
  const first = await service.findPage({ page_size: 20 }, context());
  ids.slice(20, 50).forEach((id) => joined.delete(id));
  readable.delete(ids[50]);
  const page = await service.findPage(
    { page_size: 20, cursor: first.next_cursor! },
    context()
  );
  expect(page.data.map((wave) => wave.id)).toEqual(ids.slice(51));
  expect(page.next_cursor).toBeNull();
  expect(mapper.mapWaves).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    { groupIdsUserIsEligibleFor: ['visible'] }
  );
});

it('does not add new memberships to an existing snapshot and includes them after refresh', async () => {
  const first = await service.findPage({ page_size: 100 }, context());
  expect(first.next_cursor).toBeNull();
  ids.unshift('new-joined');
  joined.add('new-joined');
  readable.add('new-joined');
  const refreshed = await service.findPage({ page_size: 100 }, context());
  expect(refreshed.data[0].id).toBe('new-joined');
});

it('returns an empty final page if every remaining membership was removed', async () => {
  const first = await service.findPage({ page_size: 20 }, context());
  joined.clear();
  const page = await service.findPage(
    { page_size: 20, cursor: first.next_cursor! },
    context()
  );
  expect(page.data).toEqual([]);
  expect(page.next_cursor).toBeNull();
});

it('rejects proxy access and page-size changes', async () => {
  await expect(
    service.findPage({ page_size: 20 }, context(true))
  ).rejects.toThrow('proxy');
  const first = await service.findPage({ page_size: 20 }, context());
  expect(decodeJoinedWaveCursor(first.next_cursor!).offset).toBe(20);
  await expect(
    service.findPage({ page_size: 30, cursor: first.next_cursor! }, context())
  ).rejects.toThrow('Page size cannot change');
});
