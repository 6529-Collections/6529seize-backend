import { CLOUDFRONT_LINK } from '@/constants';
import { DropType } from '@/entities/IDrop';
import {
  DropMediaCandidateRow,
  WavePictureRow
} from './chat-media-backfill.db';
import {
  CandidateContext,
  ChatMediaSource,
  classifyDropMediaRow,
  classifyWavePictureRow,
  EnvironmentGuardReason,
  OutOfScopeReason
} from './chat-media-candidates';
import {
  AmbiguityReason,
  ExclusionReason,
  MediaExclusionIndex
} from './media-exclusion-index';

const KEY = 'drops/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/6f1c2b3a.jpg';

function row(
  overrides: Partial<DropMediaCandidateRow> = {}
): DropMediaCandidateRow {
  return {
    id: 1,
    drop_id: 'drop-1',
    url: `${CLOUDFRONT_LINK}/${KEY}`,
    mime_type: 'image/jpeg',
    media_upload_id: null,
    joined_drop_id: 'drop-1',
    drop_type: DropType.CHAT,
    reply_to_drop_id: null,
    is_direct_message: null,
    upload_purpose: null,
    has_competition_entry: 0,
    ...overrides
  };
}

function context(
  index = new MediaExclusionIndex(),
  uploadKeys: Set<string> | null = null
): CandidateContext {
  return { exclusions: index, uploadKeys };
}

describe('classifyDropMediaRow', () => {
  it('selects images and videos of chat drops, replies and DMs', () => {
    expect(classifyDropMediaRow(row(), context())).toEqual({
      kind: 'target',
      target: {
        key: KEY,
        kind: 'image',
        source: ChatMediaSource.DROP_MEDIA,
        urls: [`${CLOUDFRONT_LINK}/${KEY}`],
        inDirectMessage: false,
        isReply: false
      }
    });
    const reply = classifyDropMediaRow(
      row({ reply_to_drop_id: 'entry-1', is_direct_message: 1 }),
      context()
    );
    expect(reply).toMatchObject({
      kind: 'target',
      target: { isReply: true, inDirectMessage: true }
    });
    expect(
      classifyDropMediaRow(row({ mime_type: 'video/mp4' }), context())
    ).toMatchObject({ kind: 'target', target: { kind: 'video' } });
  });

  it.each([DropType.PARTICIPATORY, DropType.WINNER, DropType.COMPETITION])(
    'never selects media on a %s drop',
    (dropType) => {
      expect(
        classifyDropMediaRow(row({ drop_type: dropType }), context())
      ).toEqual({
        kind: 'skipped',
        key: KEY,
        reasons: [ExclusionReason.DECISION_ENTRY_MEDIA]
      });
    }
  );

  it('never selects media of a native competition entry, whatever its type', () => {
    expect(
      classifyDropMediaRow(row({ has_competition_entry: 1 }), context())
    ).toMatchObject({
      kind: 'skipped',
      reasons: [ExclusionReason.DECISION_ENTRY_MEDIA]
    });
  });

  it('skips a chat drop that reuses a decision-entry URL', () => {
    const index = new MediaExclusionIndex();
    index.addKey(KEY, ExclusionReason.DECISION_ENTRY_MEDIA);
    expect(classifyDropMediaRow(row(), context(index))).toEqual({
      kind: 'skipped',
      key: KEY,
      reasons: [ExclusionReason.DECISION_ENTRY_MEDIA]
    });
  });

  it('skips media a decision entry names in its metadata', () => {
    const index = new MediaExclusionIndex();
    index.addTextReference(KEY, ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE);
    expect(classifyDropMediaRow(row(), context(index))).toMatchObject({
      kind: 'skipped',
      reasons: [ExclusionReason.DECISION_ENTRY_TEXT_REFERENCE]
    });
  });

  it('skips uploads made as decision entries, and unknown purposes', () => {
    expect(
      classifyDropMediaRow(row({ upload_purpose: 'decision_entry' }), context())
    ).toMatchObject({
      kind: 'skipped',
      reasons: [ExclusionReason.DECISION_ENTRY_UPLOAD]
    });
    expect(
      classifyDropMediaRow(row({ upload_purpose: 'mystery' }), context())
    ).toMatchObject({
      kind: 'skipped',
      reasons: [AmbiguityReason.UNKNOWN_UPLOAD_PURPOSE]
    });
    expect(
      classifyDropMediaRow(row({ upload_purpose: 'chat' }), context())
    ).toMatchObject({ kind: 'target' });
  });

  it('reports media whose drop no longer exists as ambiguous', () => {
    expect(
      classifyDropMediaRow(
        row({ joined_drop_id: null, drop_type: null }),
        context()
      )
    ).toMatchObject({
      kind: 'skipped',
      reasons: [AmbiguityReason.ORPHAN_DROP_MEDIA]
    });
  });

  it('ignores other hosts, prefixes and media types', () => {
    expect(
      classifyDropMediaRow(row({ url: 'https://arweave.net/abc' }), context())
    ).toEqual({
      kind: 'out_of_scope',
      reason: OutOfScopeReason.NOT_WAVE_MEDIA_URL
    });
    expect(
      classifyDropMediaRow(
        row({ url: `${CLOUDFRONT_LINK}/pfp/a.jpg` }),
        context()
      )
    ).toEqual({
      kind: 'out_of_scope',
      reason: OutOfScopeReason.NOT_WAVE_MEDIA_URL
    });
    expect(
      classifyDropMediaRow(row({ mime_type: 'model/gltf-binary' }), context())
    ).toEqual({
      kind: 'out_of_scope',
      reason: OutOfScopeReason.OTHER_MEDIA_TYPE
    });
  });

  it('outside production touches only keys this environment uploaded', () => {
    expect(
      classifyDropMediaRow(row(), context(new MediaExclusionIndex(), new Set()))
    ).toEqual({
      kind: 'skipped',
      key: KEY,
      reasons: [EnvironmentGuardReason.NOT_UPLOADED_IN_THIS_ENVIRONMENT]
    });
    expect(
      classifyDropMediaRow(
        row(),
        context(new MediaExclusionIndex(), new Set([KEY]))
      )
    ).toMatchObject({ kind: 'target' });
  });
});

describe('classifyWavePictureRow', () => {
  const picture = (url: string | null): WavePictureRow => ({
    page_cursor: 3,
    wave_id: 'wave-1',
    picture: url,
    is_direct_message: 0
  });

  it('selects wave pictures under waves/', () => {
    expect(
      classifyWavePictureRow(
        picture(`${CLOUDFRONT_LINK}/waves/author_1/x.png`),
        ChatMediaSource.WAVE_PICTURE,
        context()
      )
    ).toMatchObject({
      kind: 'target',
      target: {
        key: 'waves/author_1/x.png',
        source: ChatMediaSource.WAVE_PICTURE
      }
    });
  });

  it('reports a wave picture under drops/ as ambiguous', () => {
    expect(
      classifyWavePictureRow(
        picture(`${CLOUDFRONT_LINK}/${KEY}`),
        ChatMediaSource.ARCHIVED_WAVE_PICTURE,
        context()
      )
    ).toMatchObject({
      kind: 'skipped',
      reasons: [AmbiguityReason.WAVE_PICTURE_OUTSIDE_WAVES_PREFIX]
    });
  });

  it('respects decision-entry exclusions and ignores empty pictures', () => {
    const index = new MediaExclusionIndex();
    index.addKey('waves/author_1/x.png', ExclusionReason.MINTING_CLAIM_MEDIA);
    expect(
      classifyWavePictureRow(
        picture(`${CLOUDFRONT_LINK}/waves/author_1/x.png`),
        ChatMediaSource.WAVE_PICTURE,
        context(index)
      )
    ).toMatchObject({ kind: 'skipped' });
    expect(
      classifyWavePictureRow(
        picture(null),
        ChatMediaSource.WAVE_PICTURE,
        context()
      )
    ).toEqual({ kind: 'out_of_scope', reason: OutOfScopeReason.NO_PICTURE });
    expect(
      classifyWavePictureRow(
        picture('ipfs://x'),
        ChatMediaSource.WAVE_PICTURE,
        context()
      )
    ).toEqual({
      kind: 'out_of_scope',
      reason: OutOfScopeReason.NOT_WAVE_MEDIA_URL
    });
  });
});
