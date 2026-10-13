jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {}
}));
jest.mock('@/drops/drops.db', () => ({ dropsDb: {} }));

import type { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import {
  ReleaseDigestEntity,
  ReleaseDigestEntryEntity,
  ReleaseDigestStatus
} from '@/entities/IReleaseDigest';
import type { ReleaseDigestDb } from './release-digest.db';
import {
  assertReleaseDigestKey,
  ReleaseDigestService,
  toReleaseDigestCredits,
  toReleaseDigestSourceEntries
} from './release-digest.service';
import type { ReleaseDigestDraft } from './release-digest.writer';

function anEntry(
  overrides: Partial<ReleaseDigestEntryEntity> = {}
): ReleaseDigestEntryEntity {
  return {
    id: 'entry-1',
    repository: '6529-Collections/6529seize-frontend',
    pull_request_number: 10,
    pull_request_title: 'Improve waves',
    pull_request_url:
      'https://github.com/6529-Collections/6529seize-frontend/pull/10',
    pull_request_body: 'Body',
    summary: 'Improved waves.',
    contributors: JSON.stringify([
      { github_login: 'gelato', handle: 'GelatoGenesis', profile_id: 'p1' }
    ]),
    services: '[]',
    publication_id: 'publication',
    deployed_at: 1_000,
    digest_id: 'digest-1',
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides
  };
}

function aDigest(
  overrides: Partial<ReleaseDigestEntity> = {}
): ReleaseDigestEntity {
  return {
    id: 'digest-1',
    digest_key: '2026-10-12',
    status: ReleaseDigestStatus.Pending,
    entry_count: 1,
    drop_id: null,
    created_at: 1_000,
    published_at: null,
    ...overrides
  };
}

const draft: ReleaseDigestDraft = {
  headline: 'Waves got better',
  newItems: [{ area: 'Waves', text: 'Waves got better.', entryKeys: ['E1'] }],
  fixedItems: [],
  securityItems: [],
  knownIssues: [],
  behindTheScenes: '',
  behindTheScenesKeys: [],
  buildersNote: 'Frontend: waves.'
};

function createService({
  claimed = aDigest(),
  pending = [] as ReleaseDigestEntity[],
  receipt = null as string | null,
  write = jest.fn().mockResolvedValue(draft)
} = {}) {
  const digestDb = {
    claimDigest: jest.fn().mockResolvedValue(claimed),
    findPendingDigests: jest.fn().mockResolvedValue(pending),
    findEntriesForDigest: jest.fn().mockResolvedValue([anEntry()]),
    findUnclaimedEntries: jest.fn().mockResolvedValue([anEntry()]),
    markPublished: jest.fn().mockResolvedValue(undefined)
  };
  const createDrop = jest.fn().mockResolvedValue({ id: 'new-drop' });
  const findDropIdByMetadata = jest.fn().mockResolvedValue(receipt);
  const service = new ReleaseDigestService(
    digestDb as unknown as ReleaseDigestDb,
    { write },
    { createDrop } as unknown as DropCreationApiService,
    { findDropIdByMetadata }
  );
  return { service, digestDb, createDrop, findDropIdByMetadata, write };
}

describe('ReleaseDigestService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CI_RELEASES_WAVE_ID = 'releases-wave';
    process.env.CI_PIPELINES_PROD_WAVE_ID = 'deploy-wave';
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const request = { digestKey: '2026-10-12', cutoff: 5_000, dryRun: false };

  it('claims entries, posts one digest as the CI bot, and records the receipt', async () => {
    const { service, digestDb, createDrop } = createService();

    await expect(service.publish(request, {})).resolves.toEqual({
      status: 'published',
      dropId: 'new-drop'
    });

    expect(digestDb.claimDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        digestKey: '2026-10-12',
        cutoff: 5_000,
        limit: 200
      }),
      {}
    );
    const call = createDrop.mock.calls[0];
    expect(call[0]).toMatchObject({
      authorId: 'bot-profile',
      representativeId: 'bot-profile',
      hideLinkPreview: true,
      createDropRequest: {
        wave_id: 'releases-wave',
        metadata: [
          { data_key: 'release_digest_id', data_value: 'digest-1' },
          { data_key: 'release_digest_key', data_value: '2026-10-12' }
        ],
        mentioned_users: [
          { mentioned_profile_id: 'p1', handle_in_content: 'GelatoGenesis' }
        ]
      }
    });
    expect(call[0].createDropRequest.parts[0].content).toContain(
      '### Daily release notes · 2026-10-12'
    );
    expect(call[0].createDropRequest.parts[0].content).toContain(
      'https://6529.io/waves/deploy-wave'
    );
    expect(digestDb.markPublished).toHaveBeenCalledWith(
      'digest-1',
      'new-drop',
      expect.any(Number),
      {}
    );
  });

  it('does nothing when no production changes are waiting', async () => {
    const { service, createDrop } = createService({ claimed: null as never });

    await expect(service.publish(request, {})).resolves.toEqual({
      status: 'nothing-to-publish'
    });
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('does not repost an already published digest', async () => {
    const { service, createDrop } = createService({
      claimed: aDigest({
        status: ReleaseDigestStatus.Published,
        drop_id: 'old-drop'
      })
    });

    await expect(service.publish(request, {})).resolves.toEqual({
      status: 'already-published',
      dropId: 'old-drop'
    });
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('reconciles a drop posted before a crash instead of posting again', async () => {
    const { service, digestDb, createDrop, write } = createService({
      receipt: 'posted-drop'
    });

    await expect(service.publish(request, {})).resolves.toEqual({
      status: 'already-published',
      dropId: 'posted-drop'
    });
    expect(createDrop).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(digestDb.markPublished).toHaveBeenCalledWith(
      'digest-1',
      'posted-drop',
      expect.any(Number),
      {}
    );
  });

  it('finishes earlier unfinished digests first', async () => {
    const { service, createDrop } = createService({
      pending: [aDigest({ id: 'stale', digest_key: '2026-10-11' })]
    });

    await service.publish(request, {});

    expect(createDrop).toHaveBeenCalledTimes(2);
    expect(
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content
    ).toContain('2026-10-11');
  });

  it('falls back to plain summaries after two failed generations', async () => {
    const write = jest.fn().mockRejectedValue(new Error('bedrock down'));
    const { service, createDrop } = createService({ write });

    await service.publish(request, {});

    expect(write).toHaveBeenCalledTimes(2);
    expect(
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content
    ).toContain('- **Frontend:** Improved waves.');
  });

  it('previews without claiming or posting on a dry run', async () => {
    const { service, digestDb, createDrop } = createService();

    const outcome = await service.publish({ ...request, dryRun: true }, {});

    expect(outcome).toEqual({
      status: 'dry-run',
      content: expect.stringContaining('Waves got better')
    });
    expect(digestDb.claimDigest).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('rejects malformed digest keys', async () => {
    const { service } = createService();
    await expect(
      service.publish({ ...request, digestKey: 'tomorrow' }, {})
    ).rejects.toThrow('Invalid release digest key');
    expect(assertReleaseDigestKey('2026-10-12-retry2')).toBe(
      '2026-10-12-retry2'
    );
  });
});

describe('digest entry helpers', () => {
  it('keeps the latest record of each pull request and assigns prompt ids', () => {
    const entries = toReleaseDigestSourceEntries([
      anEntry({ id: 'b', deployed_at: 3_000, summary: 'Newer.' }),
      anEntry({ id: 'a', deployed_at: 2_000, summary: 'Older.' }),
      anEntry({
        id: 'c',
        repository: '6529-Collections/6529seize-backend',
        deployed_at: 1_000,
        services: '["api"]'
      })
    ]);

    expect(entries.map(({ key, summary }) => [key, summary])).toEqual([
      ['E1', 'Improved waves.'],
      ['E2', 'Newer.']
    ]);
    expect(entries[0].services).toEqual(['api']);
  });

  it('reads contributor credits and tolerates malformed rows', () => {
    expect(
      toReleaseDigestCredits([anEntry(), anEntry({ contributors: 'not json' })])
    ).toEqual([
      { githubLogin: 'gelato', handle: 'GelatoGenesis', profileId: 'p1' }
    ]);
  });
});
