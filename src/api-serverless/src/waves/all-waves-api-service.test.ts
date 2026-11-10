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
import { AllWavesApiService } from './all-waves.api.service';
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
const service = new AllWavesApiService(
  {
    findAllRootWaveIds: findIds,
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
    waveIds
      .filter((id) => readable.has(id))
      .map(
        (id) =>
          ({ id, parent_wave_id: null, is_direct_message: false }) as WaveEntity
      )
  );
});

it('returns every accessible wave once even when activity order changes across page boundaries', async () => {
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

it('rechecks access on continuation and fills past revoked or deleted waves', async () => {
  const first = await service.findPage({ page_size: 20 }, context());
  ids.slice(20, 51).forEach((id) => readable.delete(id));
  const next = await service.findPage(
    { page_size: 20, cursor: first.next_cursor! },
    context()
  );
  expect(next.data.map((wave) => wave.id)).toEqual(ids.slice(51));
  expect(next.next_cursor).toBeNull();
});

it('allows guests, includes unjoined waves, and binds storage to the guest scope', async () => {
  const result = await service.findPage({ page_size: 20 }, {});
  expect(result.data).toHaveLength(20);
  expect(findIds).toHaveBeenCalledWith(
    { identityId: null, eligibleGroups: [] },
    {}
  );
  expect(snapshots.create).toHaveBeenCalledWith('guest', ids, 20);
});

it('keeps a continuation after a fully pruned scan window', async () => {
  ids = Array.from({ length: 600 }, (_, i) => `wave-${i}`);
  readable = new Set(ids);
  joined = new Set(ids);
  const first = await service.findPage({ page_size: 20 }, context());
  ids.slice(20, 550).forEach((id) => readable.delete(id));
  const empty = await service.findPage(
    { page_size: 20, cursor: first.next_cursor! },
    context()
  );
  expect(empty.data).toEqual([]);
  expect(empty.next_cursor).not.toBeNull();
  const next = await service.findPage(
    { page_size: 20, cursor: empty.next_cursor! },
    context()
  );
  expect(next.data.map((wave) => wave.id)).toEqual(ids.slice(550, 570));
});
