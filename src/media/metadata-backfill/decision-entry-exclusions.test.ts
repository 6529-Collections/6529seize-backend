import { CLOUDFRONT_LINK } from '@/constants';
import { DropType } from '@/entities/IDrop';
import {
  ChatMediaBackfillDb,
  DropTextRow,
  NonChatDropRow,
  UploadPurposeRow
} from './chat-media-backfill.db';
import {
  DecisionEntryExclusions,
  dropReasons
} from './decision-entry-exclusions';
import { AmbiguityReason, ExclusionReason } from './media-exclusion-index';

const url = (key: string) => `${CLOUDFRONT_LINK}/${key}`;

class FakeDb {
  drops: NonChatDropRow[] = [];
  entries: { id: string; drop_id: string }[] = [];
  media: DropTextRow[] = [];
  texts: DropTextRow[] = [];
  uploads: UploadPurposeRow[] = [];
  claims: {
    drop_id: string;
    image_url: string | null;
    animation_url: string | null;
  }[] = [];
  orphans: { id: number; drop_id: string; url: string }[] = [];

  async findNonChatDropsAfter(after: number, limit: number) {
    return this.drops
      .filter((d) => Number(d.serial_no) > after)
      .slice(0, limit);
  }
  async findCompetitionEntryDropsAfter(after: string, limit: number) {
    return this.entries.filter((e) => e.id > after).slice(0, limit);
  }
  async findMediaUrlsOfDrops(ids: string[]) {
    return this.media.filter((m) => ids.includes(m.drop_id));
  }
  async findTextsOfDrops(ids: string[]) {
    return this.texts.filter((t) => ids.includes(t.drop_id));
  }
  async findUploadsAfter(after: string, limit: number) {
    return this.uploads.filter((u) => u.id > after).slice(0, limit);
  }
  async findMintingClaimMediaAfter(after: string, limit: number) {
    return this.claims.filter((c) => c.drop_id > after).slice(0, limit);
  }
  async findOrphanDropMediaAfter(after: number, limit: number) {
    const page = this.orphans.filter((o) => o.id > after).slice(0, limit);
    return {
      rows: page,
      lastId: page.length ? page[page.length - 1].id : null
    };
  }
}

function drop(
  serial: number,
  id: string,
  dropType: string,
  replyTo: string | null = null
): NonChatDropRow {
  return {
    serial_no: serial,
    id,
    drop_type: dropType,
    reply_to_drop_id: replyTo
  };
}

async function built(db: FakeDb, collectUploadKeys = false) {
  const exclusions = new DecisionEntryExclusions(
    db as unknown as ChatMediaBackfillDb,
    2
  );
  await exclusions.build({ collectUploadKeys });
  return exclusions;
}

describe('dropReasons', () => {
  it('treats participatory, winner and native entries as decision entries', () => {
    for (const type of [
      DropType.PARTICIPATORY,
      DropType.WINNER,
      DropType.COMPETITION
    ]) {
      expect(dropReasons(drop(1, 'd', type)).media).toBe(
        ExclusionReason.DECISION_ENTRY_MEDIA
      );
    }
  });

  it('treats non-chat replies and unknown types as ambiguous', () => {
    expect(dropReasons(drop(1, 'd', DropType.PARTICIPATORY, 'p')).media).toBe(
      AmbiguityReason.NON_CHAT_REPLY
    );
    expect(dropReasons(drop(1, 'd', 'FUTURE_TYPE')).media).toBe(
      AmbiguityReason.UNKNOWN_DROP_TYPE
    );
  });
});

describe('DecisionEntryExclusions', () => {
  it('indexes decision-entry media, metadata media and native entry content', async () => {
    const db = new FakeDb();
    db.drops = [
      drop(1, 'entry', DropType.PARTICIPATORY),
      drop(2, 'winner', DropType.WINNER),
      drop(3, 'native', DropType.COMPETITION),
      drop(4, 'odd-reply', DropType.PARTICIPATORY, 'parent')
    ];
    db.media = [
      { drop_id: 'entry', text: url('drops/u1/art.png') },
      { drop_id: 'winner', text: url('drops/u2/winner.gif') },
      { drop_id: 'odd-reply', text: url('drops/u9/reply.png') }
    ];
    db.texts = [
      {
        drop_id: 'entry',
        text: JSON.stringify({
          artist_profile_media: [url('drops/u3/profile.jpg')],
          artwork_commentary_media: [
            url('drops/author_5/commentary photo.jpg')
          ],
          preview_image: url('drops/u4/preview.png'),
          promo_video: url('drops/u5/promo.mp4')
        })
      },
      {
        drop_id: 'native',
        text: { media: [{ url: url('drops/u6/entry.webp') }] }
      }
    ];
    const { index, stats } = await built(db);
    for (const key of [
      'drops/u1/art.png',
      'drops/u2/winner.gif',
      'drops/u3/profile.jpg',
      'drops/author_5/commentary photo.jpg',
      'drops/u4/preview.png',
      'drops/u5/promo.mp4',
      'drops/u6/entry.webp'
    ]) {
      expect(index.reasonsFor(key).length).toBeGreaterThan(0);
    }
    expect(index.reasonsFor('drops/u9/reply.png')).toEqual([
      AmbiguityReason.NON_CHAT_REPLY
    ]);
    expect(index.reasonsFor('drops/author_5/other chat.jpg')).toEqual([]);
    expect(stats).toMatchObject({
      decision_entry_drops: 3,
      ambiguous_drops: 1
    });
  });

  it('indexes drops listed as competition entries even when typed chat', async () => {
    const db = new FakeDb();
    db.entries = [{ id: 'e1', drop_id: 'legacy' }];
    db.media = [{ drop_id: 'legacy', text: url('drops/u7/a.png') }];
    const { index } = await built(db);
    expect(index.reasonsFor('drops/u7/a.png')).toEqual([
      ExclusionReason.DECISION_ENTRY_MEDIA
    ]);
  });

  it('indexes decision-entry uploads, unknown purposes, claims and orphans', async () => {
    const db = new FakeDb();
    db.uploads = [
      {
        id: 'a',
        public_key: 'drops/a/x.png',
        public_url: url('drops/a/x.png'),
        purpose: 'decision_entry'
      },
      {
        id: 'b',
        public_key: 'drops/b/x.png',
        public_url: url('drops/b/x.png'),
        purpose: 'chat'
      },
      {
        id: 'c',
        public_key: 'drops/c/x.png',
        public_url: url('drops/c/x.png'),
        purpose: null
      },
      {
        id: 'd',
        public_key: 'drops/d/x.png',
        public_url: url('drops/d/x.png'),
        purpose: 'mystery'
      }
    ];
    db.claims = [
      {
        drop_id: 'm1',
        image_url: url('drops/e/claim.png'),
        animation_url: null
      }
    ];
    db.orphans = [{ id: 5, drop_id: 'gone', url: url('drops/f/x.png') }];
    const exclusions = await built(db, true);
    const { index } = exclusions;
    expect(index.reasonsFor('drops/a/x.png')).toEqual([
      ExclusionReason.DECISION_ENTRY_UPLOAD
    ]);
    expect(index.reasonsFor('drops/b/x.png')).toEqual([]);
    expect(index.reasonsFor('drops/c/x.png')).toEqual([]);
    expect(index.reasonsFor('drops/d/x.png')).toEqual([
      AmbiguityReason.UNKNOWN_UPLOAD_PURPOSE
    ]);
    expect(index.reasonsFor('drops/e/claim.png')).toEqual([
      ExclusionReason.MINTING_CLAIM_MEDIA
    ]);
    expect(index.reasonsFor('drops/f/x.png')).toEqual([
      AmbiguityReason.ORPHAN_DROP_MEDIA
    ]);
    expect(exclusions.uploadKeys).toEqual(
      new Set([
        'drops/a/x.png',
        'drops/b/x.png',
        'drops/c/x.png',
        'drops/d/x.png'
      ])
    );
    expect(exclusions.stats).toMatchObject({
      decision_entry_uploads: 1,
      unknown_purpose_uploads: 1,
      uploads_scanned: 4,
      minting_claims: 1,
      orphan_drop_media_rows: 1
    });
  });

  it('refresh picks up decision entries created after the build', async () => {
    const db = new FakeDb();
    db.drops = [drop(1, 'old', DropType.PARTICIPATORY)];
    const exclusions = await built(db);
    expect(exclusions.uploadKeys).toBeNull();
    db.drops.push(drop(9, 'new', DropType.PARTICIPATORY));
    db.media.push({ drop_id: 'new', text: url('drops/n/new.png') });
    expect(exclusions.index.reasonsFor('drops/n/new.png')).toEqual([]);
    await exclusions.refresh();
    expect(exclusions.index.reasonsFor('drops/n/new.png')).toEqual([
      ExclusionReason.DECISION_ENTRY_MEDIA
    ]);
  });
});
