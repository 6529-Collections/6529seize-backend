// A decision made on the chain, from the chain index's rows to 6529.io's
// competition tables, read back through the v3 competition route by its
// chain id.
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser: () => jest.fn(),
  maybeAuthenticatedUser: () => jest.fn()
}));

import 'reflect-metadata';
import { getAuthenticationContext } from '@/api/auth/auth';
import { competitionChainIdPaths } from '@/api/competitions/competition-chain-id.middleware';
import { handleGetWaveCompetitionV3 } from '@/api/competitions/competitions-v3.handlers';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { AuthenticationContext } from '@/auth-context';
import { rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import { competitionRepository } from '@/competitions/competition.repository';
import {
  ADDRESS_CONSOLIDATION_KEY,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITIONS_TABLE,
  IDENTITIES_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  ensurePrincipalMap,
  mapPrincipals
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  aChainGroupRow,
  aChainWaveRow,
  aDecisionConfig,
  aDecisionDoc,
  aWaveDoc,
  chainWord,
  FIRST_RESULT
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import {
  EMPTY_INDEX_STATE,
  WavesChainIndexDb
} from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import {
  decisionRow,
  groupRow,
  waveRow
} from '@/waves-chain-index/waves-chain-index.rows';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { DOC_CLASS, docCommitment } from './waves-chain-mirror.docs';
import { nativeCompetitionId } from './waves-chain-mirror.ids';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { WavesChainMirror } from './waves-chain-mirror.service';

const NOW = 1_765_000_000_000;
const CREATED_AT = 1_764_500_000_000;
const P1 = chainWord('11');
const CREATOR = 'profile-1';
const G = chainWord('0a');
const W = chainWord('0b');
const D = chainWord('d1');
const ZERO = chainWord('00');
const IMPORTED = chainWord('d2');
const IMPORTED_ID = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
const IMPORTED_WAVE = '0b1c2d3e-0000-4000-8000-0000000000aa';
const NONCE = `0x${'5a'.repeat(16)}`;

const bytesOf = (doc: unknown) => Buffer.from(`${JSON.stringify(doc)}\n`);

const event = (
  height: number,
  kind: 'WAVE_CREATED' | 'GROUP_CREATED',
  fields: Partial<ChainEvent>
): ChainEvent => ({
  height,
  seq: 0,
  blockTime: CREATED_AT + height,
  kind,
  origin: 'OPERATION',
  waveId: null,
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
  data: {},
  ...fields
});

describe('a decision made on the chain, in the database', () => {
  beforeEach(async () => {
    await clearMirrorTables(sqlExecutor);
    await sqlExecutor.execute(`delete from ${PROFILES_TABLE}`);
  });

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const objects = new WavesChainObjectsMirror(
    new WavesChainObjectsDb(() => sqlExecutor),
    (ids) => db.profilesOfPrincipals(ids),
    defaultObjectEffects,
    { check: jest.fn().mockResolvedValue({ kind: 'allowed' }) },
    () => NOW
  );
  const stamp = { height: 20, generation: 1 };

  it('gets a competitions row as 6529.io creates one, published as on the chain, read by its chain id', async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: CREATOR });
    const wallet = `0x${'1f'.repeat(20)}`;
    await sqlExecutor.execute(
      `insert into ${IDENTITIES_TABLE}
         (profile_id, consolidation_key, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw)
       values (:id, :w, :w, 'creatorone', 'creatorone', 0, 0, 0, 0)`,
      { id: CREATOR, w: wallet }
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
       values (:id, 'creatorone', 'creatorone', :w, now(), :w, 'PSEUDONYM')`,
      { id: CREATOR, w: wallet }
    );

    // A group and a public wave made on the chain.
    const group = aChainGroupRow(
      G,
      { includes: [{ kind: 'principal', value: P1 }] },
      { controller: P1 }
    );
    await index.upsert(
      'groups',
      [groupRow({ ...(group.data as ChainObject), legacyId: null })],
      stamp
    );
    const waveDoc = bytesOf(aWaveDoc());
    await db.saveDocument(rawCidHexOf(waveDoc), DOC_CLASS.WAVE, waveDoc);
    const wave = aChainWaveRow(W, { metadataCid: rawCidHexOf(waveDoc) });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(wave.data as ChainObject),
          legacyId: null,
          origin: 'native',
          status: 'open',
          readGroup: { groupId: ZERO },
          postGroup: { groupId: ZERO },
          adminGroup: { groupId: ZERO }
        })
      ],
      stamp
    );
    await index.writeEvents(
      [
        event(18, 'GROUP_CREATED', { groupId: G }),
        event(19, 'WAVE_CREATED', { waveId: W })
      ],
      21,
      UNKNOWN_SCAN
    );

    // The decision: its document and the outcome template it commits to.
    const template = bytesOf({
      v: 1,
      kind: 'outcomes',
      decision: null,
      outcomes: [
        {
          type: 'MANUAL',
          description: 'A prize',
          distribution: [{ amount: null, description: 'First place' }]
        }
      ],
      nonce: NONCE
    });
    const templateCid = rawCidHexOf(template);
    await db.saveDocument(templateCid, DOC_CLASS.OUTCOME_TEMPLATE, template);
    const doc = bytesOf(aDecisionDoc({ outcome_template_cid: templateCid }));
    await db.saveDocument(rawCidHexOf(doc), DOC_CLASS.DECISION, doc);
    const decision = (status: string, legacyId: string | null, id = D) =>
      decisionRow({
        decisionId: id,
        legacyId,
        waveId: W,
        configVersion: 1,
        status,
        kind: 'rank',
        origin: legacyId ? 'legacy' : 'native',
        counted: true,
        nextResultTime: FIRST_RESULT,
        metadataCid: rawCidHexOf(doc),
        submitGroup: { groupId: G, version: 1 },
        voteGroup: { groupId: ZERO, version: 0 },
        config: aDecisionConfig({
          outcomeTemplateHash: docCommitment(
            DOC_CLASS.OUTCOME_TEMPLATE,
            `${NONCE}${'00'.repeat(16)}`,
            template
          )
        })
      });
    await index.upsert(
      'decisions',
      [
        decision('published', null),
        decision('published', IMPORTED_ID, IMPORTED)
      ],
      { height: 30, generation: 1 }
    );

    const objectsMirror = {
      run: (input: Parameters<WavesChainObjectsMirror['run']>[0]) =>
        objects.run(input)
    };
    await index.saveState(
      {
        ...EMPTY_INDEX_STATE,
        generation: 1,
        lastFullAt: 1,
        feedNext: 31,
        network: 'net-1'
      },
      1
    );
    const report = await new WavesChainMirror(
      db,
      index,
      () => ({
        write: true,
        frozen: true,
        keepMainStage: false,
        mainStageWaveId: null
      }),
      () => NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      objectsMirror
    ).run({ budgetMs: 60_000 });
    expect(report.objects?.decisions).toMatchObject({ mirrored: 1, failed: 0 });

    const id = nativeCompetitionId(D);
    // Created as a draft, then published by the decisions pass.
    expect(
      await sqlExecutor.execute(
        `select id, wave_id, legacy_wave_id, chain_id, execution_mode,
                lifecycle, type, title, config_version,
                json_unquote(json_extract(decision_config, '$.next_decision_time'))
                  as next,
                json_unquote(json_extract(participation_config, '$.group_id'))
                  as submit_group,
                published_at
           from ${COMPETITIONS_TABLE}`
      )
    ).toEqual([
      {
        id,
        wave_id: W,
        legacy_wave_id: null,
        chain_id: D,
        execution_mode: 'DISABLED',
        lifecycle: 'PUBLISHED',
        type: 'RANK',
        title: 'Made on the chain',
        config_version: 1,
        next: String(FIRST_RESULT),
        submit_group: G,
        published_at: NOW
      }
    ]);
    expect(
      await sqlExecutor.execute(
        `select version from ${COMPETITION_CONFIG_VERSIONS_TABLE}
          where competition_id = :id`,
        { id }
      )
    ).toEqual([{ version: 1 }]);
    expect(
      await sqlExecutor.execute(
        `select position, type, description from ${COMPETITION_OUTCOMES_TABLE}
          where competition_id = :id`,
        { id }
      )
    ).toEqual([{ position: 1, type: 'MANUAL', description: 'A prize' }]);
    expect(
      (
        await sqlExecutor.execute<{ lifecycle: string }>(
          `select lifecycle from ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
            where competition_id = :id order by created_at, lifecycle`,
          { id }
        )
      ).map((row) => row.lifecycle)
    ).toEqual(expect.arrayContaining(['DRAFT', 'PUBLISHED']));
    expect(
      (
        await sqlExecutor.execute<{ event: unknown }>(
          `select event from ${COMPETITION_OUTBOX_TABLE}
            where competition_id = :id`,
          { id }
        )
      ).map(
        (row) =>
          (typeof row.event === 'string' ? JSON.parse(row.event) : row.event)
            .event_type
      )
    ).toContain('COMPETITION_CREATED');

    // Its chain id resolves to its row; an imported decision's to its own.
    expect(await competitionRepository.findCompetitionIdOfChainId(D, {})).toBe(
      id
    );
    expect(
      await competitionRepository.findCompetitionIdOfChainId(IMPORTED, {})
    ).toBe(IMPORTED_ID);
    expect(
      await competitionRepository.findImportedChainDecisionId(IMPORTED_ID, {})
    ).toBe(IMPORTED);

    // Read through the v3 route by its chain id, signed out.
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.notAuthenticated());
    const req = {
      url: `/v3/waves/${W}/competitions/${D}`
    } as { url: string };
    await competitionChainIdPaths()(req as any, {} as any, jest.fn());
    expect(req.url).toBe(`/v3/waves/${W}/competitions/${id}`);
    const competition = await handleGetWaveCompetitionV3({
      params: { wave_id: W, competition_id: id },
      query: {}
    } as any);
    expect(competition).toMatchObject({
      id,
      chain_id: D,
      wave_id: W,
      lifecycle: 'PUBLISHED',
      title: 'Made on the chain',
      permissions: { view: true, submit: false, vote: false }
    });
    // Signed in as a member of its submit group (open periods, no vote
    // group): offered both, as an imported decision would offer them.
    // (At the mirror's time, before its first result.)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId(CREATOR));
    expect(
      (
        await handleGetWaveCompetitionV3({
          params: { wave_id: W, competition_id: id },
          query: {}
        } as any)
      ).permissions
    ).toMatchObject({ view: true, submit: true, vote: true });
    clock.mockRestore();
    // The runtime still never runs it.
    expect(
      await sqlExecutor.execute(
        `select execution_mode from ${COMPETITIONS_TABLE} where id = :id`,
        { id }
      )
    ).toEqual([{ execution_mode: 'DISABLED' }]);

    // An imported wave's chain id, from the index's row.
    const importedWave = aChainWaveRow(chainWord('0c'), {
      legacyId: IMPORTED_WAVE,
      origin: 'legacy'
    });
    await index.upsert(
      'waves',
      [
        waveRow({
          ...(importedWave.data as ChainObject),
          legacyId: IMPORTED_WAVE,
          origin: 'legacy',
          status: 'open',
          readGroup: { groupId: ZERO },
          postGroup: { groupId: ZERO },
          adminGroup: { groupId: ZERO }
        })
      ],
      stamp
    );
    expect(
      await wavesApiDb.findChainIdsOfImportedWaves([IMPORTED_WAVE, W], {})
    ).toEqual({ [IMPORTED_WAVE]: chainWord('0c') });
  });
});
