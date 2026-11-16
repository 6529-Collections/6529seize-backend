import 'reflect-metadata';
import {
  CLOUDFRONT_LINK,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MEDIA_UPLOADS_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  MINTING_CLAIMS_TABLE,
  WAVES_ARCHIVE_TABLE
} from '@/constants';
import { RETIRED_WAVE_COMPETITION_COLUMNS } from '@/competitions/legacy-competition-get-facade';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  CandidateContext,
  CandidateDecision,
  ChatMediaSource,
  classifyDropMediaRow,
  classifyWavePictureRow,
  EnvironmentGuardReason
} from './chat-media-candidates';
import { ChatMediaBackfillDb } from './chat-media-backfill.db';
import { DecisionEntryExclusions } from './decision-entry-exclusions';
import { AmbiguityReason, ExclusionReason } from './media-exclusion-index';

const url = (key: string) => `${CLOUDFRONT_LINK}/${key}`;
const chatWave = aWave(
  { picture: url('waves/author_1/pic.jpg') },
  { id: 'wave-chat', serial_no: 1, name: 'Chat' }
);
const dmWave = aWave(
  { is_direct_message: true },
  { id: 'wave-dm', serial_no: 2, name: 'DM' }
);
const archivedChatWave = Object.fromEntries(
  Object.entries({
    ...chatWave,
    picture: url('waves/author_1/old.jpg'),
    archive_id: 1,
    archival_entry_created_at: 1
  }).filter(([column]) => !RETIRED_WAVE_COMPETITION_COLUMNS.includes(column))
);

let serial = 0;
function drop(
  id: string,
  dropType: DropType,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    serial_no: ++serial,
    wave_id: 'wave-chat',
    author_id: 'author',
    created_at: serial,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    drop_type: dropType,
    ...overrides
  };
}

function media(
  dropId: string,
  key: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    drop_id: dropId,
    drop_part_id: 1,
    url: url(key),
    mime_type: 'image/jpeg',
    media_upload_id: null,
    wave_id: 'wave-chat',
    ...overrides
  };
}

function upload(id: string, key: string, purpose: string | null) {
  return {
    id,
    profile_id: 'author',
    source: 'drop',
    public_key: key,
    public_url: url(key),
    ingest_bucket: 'ingest',
    ingest_key: `prod/drop-media-ingest/${key}`,
    s3_upload_id: `s3-${id}`,
    declared_mime_type: 'image/jpeg',
    status: 'ready',
    error_reason: null,
    drop_id: null,
    wave_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: 1,
    purpose
  };
}

const MEMES_ADDITIONAL_MEDIA = JSON.stringify({
  artist_profile_media: [url('drops/author_9/profile photo.jpg')],
  artwork_commentary_media: [],
  preview_image: url('drops/e2/preview.png'),
  promo_video: ''
});

async function decisions(collectUploadKeys: boolean) {
  const db = new ChatMediaBackfillDb(() => sqlExecutor);
  const exclusions = new DecisionEntryExclusions(db, 2);
  await exclusions.build({ collectUploadKeys });
  const context: CandidateContext = {
    exclusions: exclusions.index,
    uploadKeys: exclusions.uploadKeys
  };
  const results: CandidateDecision[] = [];
  for (let after = 0; ; ) {
    const rows = await db.findDropMediaCandidatesAfter(after, 2);
    if (!rows.length) break;
    after = Number(rows[rows.length - 1].id);
    results.push(...rows.map((row) => classifyDropMediaRow(row, context)));
  }
  for (const [phase, read] of [
    [ChatMediaSource.WAVE_PICTURE, db.findWavePicturesAfter.bind(db)],
    [
      ChatMediaSource.ARCHIVED_WAVE_PICTURE,
      db.findArchivedWavePicturesAfter.bind(db)
    ]
  ] as const) {
    for (let after = 0; ; ) {
      const rows = await read(after, 2);
      if (!rows.length) break;
      after = Number(rows[rows.length - 1].page_cursor);
      results.push(
        ...rows.map((row) => classifyWavePictureRow(row, phase, context))
      );
    }
  }
  return { results, exclusions };
}

function targetKeys(results: CandidateDecision[]): string[] {
  return results
    .flatMap((decision) =>
      decision.kind === 'target'
        ? [`${decision.target.kind}:${decision.target.key}`]
        : []
    )
    .sort((a, b) => a.localeCompare(b));
}

function skippedReasons(
  results: CandidateDecision[]
): Record<string, string[]> {
  const reasons: Record<string, string[]> = {};
  for (const decision of results) {
    if (decision.kind !== 'skipped') continue;
    reasons[decision.key] = Array.from(
      new Set([...(reasons[decision.key] ?? []), ...decision.reasons])
    ).sort((a, b) => a.localeCompare(b));
  }
  return reasons;
}

describeWithSeed(
  'chat media backfill selection',
  [
    withWaves([chatWave, dmWave]),
    { table: WAVES_ARCHIVE_TABLE, rows: [archivedChatWave] },
    {
      table: DROPS_TABLE,
      rows: [
        drop('chat-1', DropType.CHAT),
        drop('dm-1', DropType.CHAT, { wave_id: 'wave-dm' }),
        drop('entry-1', DropType.PARTICIPATORY),
        drop('reply-1', DropType.CHAT, { reply_to_drop_id: 'entry-1' }),
        drop('winner-1', DropType.WINNER),
        drop('native-1', DropType.COMPETITION),
        drop('migrated-entry', DropType.CHAT),
        drop('chat-shared', DropType.CHAT),
        drop('chat-meta', DropType.CHAT),
        drop('chat-profile', DropType.CHAT),
        drop('chat-inline', DropType.CHAT),
        drop('chat-native', DropType.CHAT),
        drop('chat-purpose', DropType.CHAT),
        drop('chat-purpose-key', DropType.CHAT),
        drop('chat-claim', DropType.CHAT),
        drop('chat-orphan-shared', DropType.CHAT),
        drop('chat-video', DropType.CHAT)
      ]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: 'entry-1',
          drop_part_id: 1,
          content: `Process notes ![wip](${url('drops/e3/inline.gif')})`,
          quoted_drop_id: null,
          quoted_drop_part_id: null,
          wave_id: 'wave-chat'
        }
      ]
    },
    {
      table: DROP_METADATA_TABLE,
      rows: [
        {
          drop_id: 'entry-1',
          data_key: 'additional_media',
          data_value: MEMES_ADDITIONAL_MEDIA,
          wave_id: 'wave-chat'
        }
      ]
    },
    {
      table: DROP_MEDIA_TABLE,
      rows: [
        media('chat-1', 'drops/c1/a.jpg', { media_upload_id: 'up-chat' }),
        media('dm-1', 'drops/c2/dm.png', {
          mime_type: 'image/png',
          wave_id: 'wave-dm'
        }),
        media('entry-1', 'drops/e1/art.png', { mime_type: 'image/png' }),
        media('reply-1', 'drops/c3/reply.jpg'),
        media('winner-1', 'drops/e4/win.jpg'),
        media('migrated-entry', 'drops/e6/legacy.jpg'),
        media('chat-shared', 'drops/e1/art.png', { mime_type: 'image/png' }),
        media('chat-meta', 'drops/e2/preview.png', { mime_type: 'image/png' }),
        media('chat-profile', 'drops/author_9/profile photo.jpg'),
        media('chat-inline', 'drops/e3/inline.gif', { mime_type: 'image/gif' }),
        media('chat-native', 'drops/e5/native.webp', {
          mime_type: 'image/webp'
        }),
        media('chat-purpose', 'drops/u1/x.jpg', {
          media_upload_id: 'up-entry'
        }),
        media('chat-purpose-key', 'drops/u2/y.jpg'),
        media('chat-claim', 'drops/m1/claim.png', { mime_type: 'image/png' }),
        media('deleted-drop', 'drops/o1/gone.jpg'),
        media('chat-orphan-shared', 'drops/o1/gone.jpg'),
        media('chat-video', 'drops/c4/clip.mp4', { mime_type: 'video/mp4' })
      ]
    },
    {
      table: DROP_MEDIA_UPLOADS_TABLE,
      rows: [
        upload('up-chat', 'drops/c1/a.jpg', 'chat'),
        upload('up-entry', 'drops/u1/x.jpg', 'decision_entry'),
        upload('up-entry-2', 'drops/u2/y.jpg', 'decision_entry')
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: 'entry-native',
          competition_id: 'competition-1',
          wave_id: 'wave-chat',
          drop_id: 'native-1',
          submitter_id: 'author',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        },
        {
          id: 'entry-withdrawn',
          competition_id: 'competition-1',
          wave_id: 'wave-chat',
          drop_id: 'migrated-entry',
          submitter_id: 'author',
          status: 'WITHDRAWN',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
    {
      table: COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
      rows: [
        {
          entry_id: 'entry-native',
          version: 1,
          competition_id: 'competition-1',
          drop_id: 'native-1',
          content: { media: [{ url: url('drops/e5/native.webp') }] },
          actor_id: 'author',
          created_at: 1
        }
      ]
    },
    {
      table: MINTING_CLAIMS_TABLE,
      rows: [
        {
          drop_id: 'winner-1',
          contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
          claim_id: 1,
          description: 'Claim',
          name: 'Claim',
          image_url: url('drops/m1/claim.png'),
          attributes: []
        }
      ]
    }
  ],
  () => {
    it('selects only chat media and explains every skip', async () => {
      const { results, exclusions } = await decisions(false);

      expect(targetKeys(results)).toEqual([
        'image:drops/c1/a.jpg',
        'image:drops/c2/dm.png',
        'image:drops/c3/reply.jpg',
        'image:waves/author_1/old.jpg',
        'image:waves/author_1/pic.jpg',
        'video:drops/c4/clip.mp4'
      ]);
      const dm = results.find(
        (decision) =>
          decision.kind === 'target' &&
          decision.target.key === 'drops/c2/dm.png'
      );
      expect(dm).toMatchObject({ target: { inDirectMessage: true } });

      const skipped = skippedReasons(results);
      expect(skipped['drops/e1/art.png']).toEqual([
        ExclusionReason.DECISION_ENTRY_MEDIA
      ]);
      expect(skipped['drops/e4/win.jpg']).toEqual([
        ExclusionReason.DECISION_ENTRY_MEDIA
      ]);
      expect(skipped['drops/e6/legacy.jpg']).toEqual([
        ExclusionReason.DECISION_ENTRY_MEDIA
      ]);
      expect(skipped['drops/e2/preview.png']).toEqual([
        ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
      ]);
      expect(skipped['drops/author_9/profile photo.jpg']).toEqual([
        ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
      ]);
      expect(skipped['drops/e3/inline.gif']).toEqual([
        ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
      ]);
      expect(skipped['drops/e5/native.webp']).toEqual([
        ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE
      ]);
      expect(skipped['drops/u1/x.jpg']).toEqual([
        ExclusionReason.DECISION_ENTRY_UPLOAD
      ]);
      expect(skipped['drops/u2/y.jpg']).toEqual([
        ExclusionReason.DECISION_ENTRY_UPLOAD
      ]);
      expect(skipped['drops/m1/claim.png']).toEqual([
        ExclusionReason.MINTING_CLAIM_MEDIA
      ]);
      expect(skipped['drops/o1/gone.jpg']).toEqual([
        AmbiguityReason.ORPHAN_DROP_MEDIA
      ]);
      expect(exclusions.stats).toMatchObject({
        decision_entry_drops: 4,
        decision_entry_uploads: 2,
        minting_claims: 1,
        orphan_drop_media_rows: 1
      });
    });

    it('outside production keeps to keys with an upload record here', async () => {
      const { results } = await decisions(true);
      expect(targetKeys(results)).toEqual(['image:drops/c1/a.jpg']);
      expect(skippedReasons(results)['drops/c3/reply.jpg']).toEqual([
        EnvironmentGuardReason.NOT_UPLOADED_IN_THIS_ENVIRONMENT
      ]);
    });

    it('a refresh excludes a decision entry created mid-run', async () => {
      const db = new ChatMediaBackfillDb(() => sqlExecutor);
      const exclusions = new DecisionEntryExclusions(db, 2);
      await exclusions.build({ collectUploadKeys: false });
      expect(exclusions.index.reasonsFor('drops/c1/a.jpg')).toEqual([]);
      await sqlExecutor.execute(
        `insert into ${DROPS_TABLE} (id, serial_no, wave_id, author_id, created_at, parts_count, drop_type)
         values ('late-entry', 999, 'wave-chat', 'author', 999, 1, :type)`,
        { type: DropType.PARTICIPATORY }
      );
      await sqlExecutor.execute(
        `insert into ${DROP_MEDIA_TABLE} (drop_id, drop_part_id, url, mime_type, wave_id)
         values ('late-entry', 1, :url, 'image/jpeg', 'wave-chat')`,
        { url: url('drops/c1/a.jpg') }
      );
      await exclusions.refresh();
      expect(exclusions.index.reasonsFor('drops/c1/a.jpg')).toEqual([
        ExclusionReason.DECISION_ENTRY_MEDIA
      ]);
    });
  }
);
