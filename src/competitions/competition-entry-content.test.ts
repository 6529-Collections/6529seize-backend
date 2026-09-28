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

const model: CreateOrUpdateDropModel = {
  drop_id: null,
  wave_id: 'hub',
  author_id: 'author',
  author_identity: 'author',
  drop_type: DropType.CHAT,
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
      { drop_type: DropType.PARTICIPATORY }
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

  it('enforces required metadata and media on stable CHAT content', () => {
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
