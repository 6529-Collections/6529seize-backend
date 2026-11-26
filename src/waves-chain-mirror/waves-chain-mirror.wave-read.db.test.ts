// A wave made on the chain whose read group admits everyone, read through
// 6529.io's own GET /waves/:id and GET /waves handlers (waves.routes.ts,
// with the real services over the database).
const mockRoutes: { method: string; path: string; handler: any }[] = [];

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => {
    const register =
      (method: string) =>
      (path: string, ...handlers: any[]) => {
        mockRoutes.push({ method, path, handler: handlers.at(-1) });
      };
    return {
      get: register('get'),
      post: register('post'),
      put: register('put'),
      delete: register('delete'),
      use: jest.fn()
    };
  }
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser: () => jest.fn(),
  maybeAuthenticatedUser: () => jest.fn()
}));

import 'reflect-metadata';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { AuthenticationContext } from '@/auth-context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILES_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  mapPrincipals
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  aChainGroupRow,
  aChainWaveRow,
  aWaveDoc,
  chainWord
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { WavesChainIndexDb } from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import { groupRow, waveRow } from '@/waves-chain-index/waves-chain-index.rows';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { PlanCounter } from './waves-chain-mirror.plan-support';
import '@/api/waves/waves.routes';

const NOW = 1_765_000_000_000;
const CREATED_AT = 1_764_500_000_000;
const P1 = chainWord('11');
const CREATOR = 'profile-1';
const OTHER = 'profile-2';
const EVERYONE = chainWord('0e');
const W = chainWord('0b');

const route = (method: string, path: string) =>
  mockRoutes.find((it) => it.method === method && it.path === path)!.handler;

async function seesById(auth: AuthenticationContext): Promise<boolean> {
  jest.mocked(getAuthenticationContext).mockResolvedValue(auth);
  const res = { locals: {}, send: jest.fn() };
  try {
    await route('get', '/:id')({ params: { id: W }, query: {} }, res);
    return res.send.mock.calls[0]?.[0]?.id === W;
  } catch {
    return false;
  }
}

async function seesInList(auth: AuthenticationContext): Promise<boolean> {
  jest.mocked(getAuthenticationContext).mockResolvedValue(auth);
  const res = { locals: {}, send: jest.fn() };
  await route('get', '/')({ params: {}, query: { limit: '50' } }, res);
  return (res.send.mock.calls[0]?.[0] ?? []).some(
    (wave: { id: string }) => wave.id === W
  );
}

async function aProfile(id: string, handle: string, wallet: string) {
  await sqlExecutor.execute(
    `insert into ${IDENTITIES_TABLE}
       (profile_id, consolidation_key, primary_address, handle,
        normalised_handle, tdh, rep, cic, level_raw)
     values (:id, :w, :w, :handle, :handle, 0, 0, 0, 0)`,
    { id, w: wallet, handle }
  );
  await sqlExecutor.execute(
    `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
     values (:w, :w)`,
    { w: wallet }
  );
  await sqlExecutor.execute(
    `insert into ${PROFILES_TABLE}
       (external_id, handle, normalised_handle, primary_wallet, created_at,
        created_by_wallet, classification)
     values (:id, :handle, :handle, :w, now(), :w, 'PSEUDONYM')`,
    { id, w: wallet, handle }
  );
}

const waveCreated: ChainEvent = {
  height: 20,
  seq: 0,
  blockTime: CREATED_AT,
  kind: 'WAVE_CREATED',
  origin: 'OPERATION',
  waveId: W,
  waveLegacyId: null,
  decisionId: null,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null,
  actor: P1,
  data: {}
};

describe('a wave on the chain whose read group admits everyone, through the waves routes', () => {
  beforeEach(async () => {
    await clearMirrorTables(sqlExecutor);
    await sqlExecutor.execute(`delete from ${PROFILES_TABLE}`);
  });

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const objectsDb = new WavesChainObjectsDb(() => sqlExecutor);
  const stamp = { height: 20, generation: 1 };

  it('is seen by every signed-in profile, its creator and another, by id and in the list; not by a signed-out reader', async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: CREATOR });
    // Profiles with no TDH at all: "everyone" may not lean on TDH above 0.
    await aProfile(CREATOR, 'creatorone', `0x${'1f'.repeat(20)}`);
    await aProfile(OTHER, 'othertwo', `0x${'2f'.repeat(20)}`);
    // ALL_CLAUSES, no clause, no list: everyone on the chain.
    const group = aChainGroupRow(
      EVERYONE,
      { predicateMode: 'all_clauses', clauses: [], includes: [], excludes: [] },
      { controller: P1 }
    );
    await index.upsert(
      'groups',
      [groupRow({ ...(group.data as ChainObject), legacyId: null })],
      stamp
    );
    const bytes = Buffer.from(`${JSON.stringify(aWaveDoc())}\n`);
    const cid = rawCidHexOf(bytes);
    await db.saveDocument(cid, 3, bytes);
    const row = aChainWaveRow(W, { read: EVERYONE, metadataCid: cid });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(row.data as ChainObject),
          legacyId: null,
          origin: 'native',
          status: 'open',
          readGroup: { groupId: EVERYONE },
          postGroup: { groupId: chainWord('00') },
          adminGroup: { groupId: chainWord('00') }
        })
      ],
      stamp
    );
    await index.writeEvents([waveCreated], 21, UNKNOWN_SCAN);

    const report = await new WavesChainObjectsMirror(
      objectsDb,
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
      () => NOW
    ).run({
      write: true,
      documents: new StoredDocuments(
        db,
        { getDocument: jest.fn().mockResolvedValue(null) },
        true
      ),
      counter: new PlanCounter(),
      outOfTime: () => false
    });
    expect(report.groups).toMatchObject({ mirrored: 1, failed: 0 });
    expect(report.waves).toMatchObject({ mirrored: 1, failed: 0 });
    // The wave keeps the group, which every identity meets.
    expect(
      await sqlExecutor.execute(
        `select visibility_group_id from ${WAVES_TABLE} where id = :id`,
        { id: W }
      )
    ).toEqual([{ visibility_group_id: EVERYONE }]);
    expect(
      await sqlExecutor.execute(
        `select tdh_min, profile_group_id, visible from ${USER_GROUPS_TABLE}
          where id = :id`,
        { id: EVERYONE }
      )
    ).toEqual([{ tdh_min: 0, profile_group_id: null, visible: true }]);
    expect(
      (await userGroupsService.getGroupsUserIsEligibleFor(OTHER)).includes(
        EVERYONE
      )
    ).toBe(true);

    const creator = AuthenticationContext.fromProfileId(CREATOR);
    const other = AuthenticationContext.fromProfileId(OTHER);
    const signedOut = AuthenticationContext.notAuthenticated();
    expect({
      creatorById: await seesById(creator),
      creatorInList: await seesInList(creator),
      otherById: await seesById(other),
      otherInList: await seesInList(other),
      signedOutById: await seesById(signedOut),
      signedOutInList: await seesInList(signedOut)
    }).toEqual({
      creatorById: true,
      creatorInList: true,
      otherById: true,
      otherInList: true,
      signedOutById: false,
      signedOutInList: false
    });

    // A wave made on the chain has its chain id as its id.
    jest.mocked(getAuthenticationContext).mockResolvedValue(creator);
    const res = { locals: {}, send: jest.fn() };
    await route('get', '/:id')({ params: { id: W }, query: {} }, res);
    expect(res.send.mock.calls[0][0]).toMatchObject({ id: W, chain_id: W });
  });
});
