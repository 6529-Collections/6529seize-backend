import { Competition } from './competition.types';
import {
  assertCompetitionEntryContent,
  assertCompetitionEntryMedia,
  assertCompetitionNominationDuplicates,
  isNativeEntryContentPermit,
  nativeEntryContentPermit
} from './competition-entry-content';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import {
  CompetitionCapability,
  CompetitionEntryStatus
} from '@/entities/ICompetition';
import * as mainStageMedia from '@/drops/main-stage-media-validator';
import { ConnectionWrapper } from '@/sql-executor';
import { CLOUDFRONT_LINK } from '@/constants';

const model: CreateOrUpdateDropModel = {
  drop_id: null,
  wave_id: 'hub',
  author_id: 'author',
  author_identity: 'author',
  drop_type: DropType.PARTICIPATORY,
  signature: null,
  title: null,
  reply_to: null,
  parts: [{ content: 'Entry', quoted_drop: null, media: [] }],
  metadata: [],
  mentioned_users: [],
  mentioned_waves: [],
  mentioned_groups: [],
  referenced_nfts: [],
  is_additional_action_promised: null
};
const competition = {
  participation: { required_metadata: [], required_media: [] }
} as unknown as Competition;

describe('Native entry content invariants', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires reuploading legacy platform media whose path exposes the uploader for anonymous entries', () => {
    const anonymous = {
      ...competition,
      participation: {
        ...competition.participation,
        anonymous_submissions: true
      }
    };
    const withUrl = (url: string): CreateOrUpdateDropModel => ({
      ...model,
      parts: [{ ...model.parts[0], media: [{ url, mime_type: 'image/png' }] }]
    });
    expect(() =>
      assertCompetitionEntryContent(
        anonymous,
        withUrl(`${CLOUDFRONT_LINK}/drops/author_author/old/photo.png`)
      )
    ).toThrow('Reupload this media');
    expect(() =>
      assertCompetitionEntryContent(
        anonymous,
        withUrl(
          `${CLOUDFRONT_LINK}/renditions/drops/author_author/old/photo.png`
        )
      )
    ).toThrow('Reupload this media');
    expect(() =>
      assertCompetitionEntryContent(
        anonymous,
        withUrl(
          `${CLOUDFRONT_LINK}/drops/9b89ed71-e722-4e7a-90b4-b637e5420231/photo.png`
        )
      )
    ).not.toThrow();
    expect(() =>
      assertCompetitionEntryContent(
        competition,
        withUrl(`${CLOUDFRONT_LINK}/drops/author_author/old/photo.png`)
      )
    ).not.toThrow();
    expect(() =>
      assertCompetitionEntryContent(
        anonymous,
        withUrl('https://example.test/author_author/photo.png')
      )
    ).not.toThrow();
  });

  it('allows a submitter to reference public artwork and disclose credits in their own content', () => {
    const submission = {
      ...model,
      author_id: 'anonymous-submitter',
      parts: [
        {
          ...model.parts[0],
          content: 'Artwork by @PublicArtist',
          media: [
            {
              url: `${CLOUDFRONT_LINK}/drops/9b89ed71-e722-4e7a-90b4-b637e5420231/photo.png`,
              mime_type: 'image/png'
            }
          ]
        }
      ],
      metadata: [{ data_key: 'artist', data_value: 'PublicArtist' }]
    };
    expect(() =>
      assertCompetitionEntryContent(
        {
          ...competition,
          participation: {
            ...competition.participation,
            anonymous_submissions: true
          }
        },
        submission
      )
    ).not.toThrow();
    expect(submission.metadata).toEqual([
      { data_key: 'artist', data_value: 'PublicArtist' }
    ]);
    expect(submission.parts[0].content).toBe('Artwork by @PublicArtist');
  });

  it('applies Main Stage media validation only to explicitly assigned competition capabilities', async () => {
    const validate = jest
      .spyOn(mainStageMedia, 'validateMainStageMediaSize')
      .mockResolvedValue(undefined);
    const withMedia = {
      ...model,
      parts: [
        {
          ...model.parts[0],
          media: [{ url: 'https://example.test/image', mime_type: 'image/png' }]
        }
      ]
    };
    await assertCompetitionEntryMedia(
      { ...competition, capabilities: [] },
      withMedia
    );
    expect(validate).not.toHaveBeenCalled();
    await assertCompetitionEntryMedia(
      { ...competition, capabilities: [CompetitionCapability.MAIN_STAGE] },
      withMedia
    );
    expect(validate).toHaveBeenCalledWith('https://example.test/image');
  });
  it('accepts only server-minted permits bound to the author, wave, content operation and transaction', () => {
    const connection = {} as ConnectionWrapper<unknown>;
    const identity = {
      competitionId: 'competition',
      waveId: model.wave_id,
      authorId: 'author',
      dropId: null,
      connection
    };
    expect(isNativeEntryContentPermit(identity, model, connection)).toBe(false);
    const permit = nativeEntryContentPermit(identity);
    expect(isNativeEntryContentPermit(permit, model, connection)).toBe(true);
    for (const changed of [
      { wave_id: 'other' },
      { author_id: 'other' },
      { drop_id: 'existing' },
      { signature: 'legacy' },
      { drop_type: DropType.CHAT }
    ]) {
      expect(
        isNativeEntryContentPermit(permit, { ...model, ...changed }, connection)
      ).toBe(false);
    }
    expect(
      isNativeEntryContentPermit(
        permit,
        model,
        {} as ConnectionWrapper<unknown>
      )
    ).toBe(false);
    expect(isNativeEntryContentPermit({ ...permit }, model, connection)).toBe(
      false
    );
  });

  it('enforces required metadata and media on dedicated submission content', () => {
    const required = {
      ...competition,
      participation: {
        ...competition.participation,
        required_metadata: [{ name: 'score', type: 'NUMBER' }],
        required_media: ['IMAGE']
      }
    };
    expect(() => assertCompetitionEntryContent(required, model)).toThrow(
      'metadata score'
    );
    const withMetadata = {
      ...model,
      metadata: [{ data_key: 'score', data_value: '5' }]
    };
    expect(() => assertCompetitionEntryContent(required, withMetadata)).toThrow(
      'media of type IMAGE'
    );
    expect(() =>
      assertCompetitionEntryContent(required, {
        ...withMetadata,
        parts: [
          {
            ...model.parts[0],
            media: [
              { url: 'https://example.test/image', mime_type: 'image/png' }
            ]
          }
        ]
      })
    ).not.toThrow();
    expect(() =>
      assertCompetitionEntryContent(competition, {
        ...model,
        reply_to: { drop_id: 'other', drop_part_id: 1 }
      })
    ).toThrow('replies');
  });

  it.each([
    ['NEVER_ALLOW', CompetitionEntryStatus.ACTIVE, true],
    ['NEVER_ALLOW', CompetitionEntryStatus.WINNER, true],
    ['NEVER_ALLOW', CompetitionEntryStatus.WITHDRAWN, false],
    ['NEVER_ALLOW', CompetitionEntryStatus.DISQUALIFIED, false],
    ['ALLOW_AFTER_WIN', CompetitionEntryStatus.ACTIVE, true],
    ['ALLOW_AFTER_WIN', CompetitionEntryStatus.WINNER, false],
    ['ALWAYS_ALLOW', CompetitionEntryStatus.ACTIVE, false]
  ] as const)('applies %s to %s nominations', (policy, status, rejects) => {
    const call = () => assertCompetitionNominationDuplicates(policy, [status]);
    if (rejects) expect(call).toThrow('already');
    else expect(call).not.toThrow();
  });
});
