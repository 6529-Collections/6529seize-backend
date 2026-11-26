import { CustomApiCompliantException } from '@/exceptions';
import {
  ModerationContentGate,
  moderationSubjectId
} from './waves-chain-mirror.gate';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';

jest.mock('@/content-moderation/pre-publication-moderation.service', () => ({
  prePublicationModerationService: { evaluate: jest.fn() },
  CONTENT_MODERATION_REJECTION_CODE: 'CONTENT_MODERATION_REJECTED'
}));

const content: NativeEntryContent = {
  title: 'A title',
  parts: [
    { content: 'one', quotedDropId: null, quotedDropPartId: null, media: [] },
    { content: null, quotedDropId: null, quotedDropPartId: null, media: [] }
  ],
  metadata: [],
  referencedNfts: [],
  mentionedUsers: [],
  mentionedWaves: [],
  mentionedGroups: [],
  hideLinkPreview: false,
  isAdditionalActionPromised: null,
  collaboratorIds: [],
  attachmentsLeftOut: 0
};
const input = {
  dropId: `0x${'e9'.repeat(32)}`,
  authorProfileId: 'author',
  waveId: 'wave',
  content
};

describe('ModerationContentGate', () => {
  it("judges an entry as 6529.io's create path judges a new drop", async () => {
    const evaluate = jest.fn().mockResolvedValue(undefined);
    expect(await new ModerationContentGate({ evaluate }).check(input)).toEqual({
      kind: 'allowed'
    });
    expect(evaluate).toHaveBeenCalledWith(
      {
        // A chain id doesn't fit moderation's drop_id: a UUIDv5 of it.
        dropId: moderationSubjectId(input.dropId),
        authorProfileId: 'author',
        waveId: 'wave',
        operation: 'CREATE',
        title: 'A title',
        parts: [{ content: 'one' }, { content: null }]
      },
      {}
    );
  });

  it("keeps a drop's own id where moderation's tables hold it", () => {
    const uuid = '0b1c2d3e-0000-4000-8000-00000000000a';
    expect(moderationSubjectId(uuid)).toBe(uuid);
    const subject = moderationSubjectId(input.dropId);
    expect(subject).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      moderationSubjectId(input.dropId.toUpperCase().replace('0X', '0x'))
    ).toBe(subject);
  });

  it('refuses only on a verdict on the content, and defers anything else', async () => {
    const refused = jest
      .fn()
      .mockRejectedValue(
        new CustomApiCompliantException(
          422,
          'no',
          'CONTENT_MODERATION_REJECTED'
        )
      );
    expect(
      await new ModerationContentGate({ evaluate: refused }).check(input)
    ).toEqual({ kind: 'refused', code: 'CONTENT_MODERATION_REJECTED' });
    // The hourly evaluator limit, a suspension, an error: asked again later.
    for (const [error, code] of [
      [
        new CustomApiCompliantException(
          429,
          'limit',
          'CONTENT_MODERATION_REVIEW_LIMIT'
        ),
        'CONTENT_MODERATION_REVIEW_LIMIT'
      ],
      [
        new CustomApiCompliantException(403, 'suspended', 'PROFILE_SUSPENDED'),
        'PROFILE_SUSPENDED'
      ],
      [new Error('database down'), 'MODERATION_UNAVAILABLE']
    ] as const) {
      const failing = jest.fn().mockRejectedValue(error);
      expect(
        await new ModerationContentGate({ evaluate: failing }).check(input)
      ).toEqual({ kind: 'deferred', code });
    }
  });
});
