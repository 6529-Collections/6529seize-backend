jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: jest.fn(
    (_wave: string, _ctx: unknown, action: (owner: null) => unknown) =>
      action(null)
  ),
  readLegacyMutationSource: (action: () => unknown) => action()
}));
jest.mock('@/competitions/competition-entry-drop-hooks');
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn(() => ({ resolveName: jest.fn() }))
}));

import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { CustomApiCompliantException } from '@/exceptions';
import { isLegacyDmClosed } from '@/legacy-dm/legacy-dm-retention';
import {
  evaluateWaveParticipationDecision,
  WaveParticipationAction,
  WaveParticipationDecision,
  WaveParticipationReasonCode
} from '@/waves/wave-participation-decision';
import {
  CreateOrUpdateDropUseCase,
  throwIfWaveParticipationDenied
} from './create-or-update-drop.use-case';

/**
 * The inspector and the write path must agree: for every matrix case the
 * use case throws iff the decision is denied, with the same reason code.
 */
const CHAT_GROUP = 'chat-group';
const ADMIN_GROUP = 'admin-group';
const AUTHOR = 'author-profile';
const REPLY_TO = { drop_id: 'announcement-1', drop_part_id: 1 };

function createWave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    type: WaveType.CHAT,
    created_by: 'creator-profile',
    admin_group_id: ADMIN_GROUP,
    visibility_group_id: null,
    participation_group_id: null,
    participation_period_start: null,
    participation_period_end: null,
    participation_max_applications_per_participant: null,
    participation_required_media: [],
    participation_required_metadata: [],
    participation_signature_required: false,
    chat_enabled: true,
    chat_group_id: CHAT_GROUP,
    chat_replies_open: false,
    chat_replies_collapsed: false,
    chat_slow_mode_cooldown_ms: null,
    chat_links_disabled: false,
    is_direct_message: false,
    ...overrides
  };
}

function createChatDropModel(overrides: Record<string, unknown> = {}) {
  return {
    drop_id: null,
    wave_id: 'wave-1',
    reply_to: null,
    title: null,
    drop_type: DropType.CHAT,
    author_identity: AUTHOR,
    author_id: AUTHOR,
    parts: [{ content: 'hello', quoted_drop: null, media: [] }],
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_waves: [],
    metadata: [],
    mentioned_groups: [],
    signature: null,
    is_additional_action_promised: null,
    ...overrides
  };
}

function createUseCase({
  wave,
  blockedUntil,
  replyTargetVisible
}: {
  wave: Record<string, unknown>;
  blockedUntil: number | null;
  replyTargetVisible: boolean;
}) {
  const wavesApiDb = {
    findById: jest.fn().mockResolvedValue(wave),
    reserveWaveChatDropCooldown: jest.fn().mockResolvedValue(blockedUntil)
  };
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest
      .fn()
      .mockResolvedValue(
        replyTargetVisible ? { id: REPLY_TO.drop_id, wave_id: 'wave-1' } : null
      )
  };
  const useCase = new CreateOrUpdateDropUseCase(
    dropsDb as any,
    {} as any,
    {} as any,
    wavesApiDb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      evaluate: jest.fn().mockResolvedValue(undefined),
      assertPostingAllowed: jest.fn().mockResolvedValue(undefined)
    } as any,
    { filterBlockedNotificationRows: jest.fn(async (rows) => rows) } as any
  );
  return { useCase, wavesApiDb, dropsDb };
}

/** The gates a chat drop passes through on write, in the use case's order. */
async function runWriteGates(
  useCase: CreateOrUpdateDropUseCase,
  wave: Record<string, unknown>,
  model: Record<string, unknown>,
  groupIdsUserIsEligibleFor: string[]
): Promise<void> {
  const ctx = { connection: {} };
  await (useCase as any).verifyWaveLimitations(
    {
      isDescriptionDrop: false,
      model,
      groupIdsUserIsEligibleFor,
      preExistingGroupMentions: []
    },
    ctx
  );
  await (useCase as any).verifyChatSlowModeLimitations(
    {
      isDescriptionDrop: false,
      wave,
      model,
      groupIdsUserIsEligibleFor
    },
    ctx
  );
}

async function expectWriteMatchesDecision({
  wave,
  action,
  groups,
  nextDropTimestamp,
  decision
}: {
  wave: Record<string, unknown>;
  action: WaveParticipationAction;
  groups: string[];
  nextDropTimestamp: number | null;
  decision: WaveParticipationDecision;
}) {
  const now = Date.now();
  const blockedUntil =
    nextDropTimestamp !== null && nextDropTimestamp > now
      ? nextDropTimestamp
      : null;
  const { useCase } = createUseCase({
    wave,
    blockedUntil,
    replyTargetVisible: true
  });
  const model = createChatDropModel(
    action === 'REPLY' ? { reply_to: REPLY_TO } : {}
  );
  const run = runWriteGates(useCase, wave, model, groups);
  if (decision.allowed) {
    await expect(run).resolves.toBeUndefined();
    return;
  }
  await expect(run).rejects.toMatchObject({ code: decision.reason_code });
  await run.catch((error: CustomApiCompliantException) => {
    expect(error.getStatusCode()).toBe(403);
  });
}

type MatrixCase = {
  name: string;
  wave?: Record<string, unknown>;
  groups: string[];
  nextDropTimestamp?: number | null;
  legacyDmCutoff?: string;
  expected: Record<WaveParticipationAction, boolean>;
};

const IN_ONE_MINUTE = () => Date.now() + 60_000;
const ONE_MINUTE_AGO = () => Date.now() - 60_000;

const MATRIX: MatrixCase[] = [
  {
    name: 'chat group member',
    groups: [CHAT_GROUP],
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'outsider, replies closed',
    groups: [],
    expected: { CHAT: false, REPLY: false }
  },
  {
    name: 'outsider, replies open',
    wave: { chat_replies_open: true },
    groups: [],
    expected: { CHAT: false, REPLY: true }
  },
  {
    name: 'no chat group configured',
    wave: { chat_group_id: null },
    groups: [],
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'chat disabled for a member',
    wave: { chat_enabled: false },
    groups: [CHAT_GROUP],
    expected: { CHAT: false, REPLY: false }
  },
  {
    name: 'chat disabled, outsider with open replies',
    wave: { chat_enabled: false, chat_replies_open: true },
    groups: [],
    expected: { CHAT: false, REPLY: false }
  },
  {
    name: 'slow mode cooldown active',
    wave: { chat_slow_mode_cooldown_ms: 60_000 },
    groups: [CHAT_GROUP],
    nextDropTimestamp: IN_ONE_MINUTE(),
    expected: { CHAT: false, REPLY: false }
  },
  {
    name: 'slow mode cooldown expired',
    wave: { chat_slow_mode_cooldown_ms: 60_000 },
    groups: [CHAT_GROUP],
    nextDropTimestamp: ONE_MINUTE_AGO(),
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'slow mode exempts admins',
    wave: { chat_slow_mode_cooldown_ms: 60_000 },
    groups: [CHAT_GROUP, ADMIN_GROUP],
    nextDropTimestamp: IN_ONE_MINUTE(),
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'slow mode exempts the creator',
    wave: { chat_slow_mode_cooldown_ms: 60_000, created_by: AUTHOR },
    groups: [CHAT_GROUP],
    nextDropTimestamp: IN_ONE_MINUTE(),
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'slow mode applies to open repliers outside the group',
    wave: { chat_slow_mode_cooldown_ms: 60_000, chat_replies_open: true },
    groups: [],
    nextDropTimestamp: IN_ONE_MINUTE(),
    expected: { CHAT: false, REPLY: false }
  },
  {
    name: 'unencrypted DM before the cutoff',
    wave: { is_direct_message: true },
    groups: [CHAT_GROUP],
    legacyDmCutoff: '2999-01-01T00:00:00Z',
    expected: { CHAT: true, REPLY: true }
  },
  {
    name: 'unencrypted DM after the cutoff',
    wave: { is_direct_message: true },
    groups: [CHAT_GROUP],
    legacyDmCutoff: '2000-01-01T00:00:00Z',
    expected: { CHAT: false, REPLY: false }
  }
];

describe('participation decision vs drop write path', () => {
  afterEach(() => {
    delete process.env.LEGACY_DM_DELETION_CUTOFF;
  });

  describe.each(MATRIX)('$name', (matrixCase) => {
    it.each(['CHAT', 'REPLY'] as const)(
      '%s: the use case throws iff the decision denies, with the same code',
      async (action) => {
        if (matrixCase.legacyDmCutoff) {
          process.env.LEGACY_DM_DELETION_CUTOFF = matrixCase.legacyDmCutoff;
        }
        const wave = createWave(matrixCase.wave);
        const nextDropTimestamp = matrixCase.nextDropTimestamp ?? null;
        const decision = evaluateWaveParticipationDecision({
          action,
          wave: wave as any,
          identity: { profileId: AUTHOR, hasCreateDropRights: true },
          groupIdsUserIsEligibleFor: matrixCase.groups,
          nextDropTimestamp,
          legacyDmClosed:
            wave.is_direct_message === true && isLegacyDmClosed(Date.now()),
          now: Date.now()
        });
        expect(decision.allowed).toBe(matrixCase.expected[action]);
        await expectWriteMatchesDecision({
          wave,
          action,
          groups: matrixCase.groups,
          nextDropTimestamp,
          decision
        });
      }
    );
  });

  it('still denies on write when membership changed after inspection', async () => {
    const wave = createWave();
    const inspected = evaluateWaveParticipationDecision({
      action: 'CHAT',
      wave: wave as any,
      identity: { profileId: AUTHOR, hasCreateDropRights: true },
      groupIdsUserIsEligibleFor: [CHAT_GROUP],
      nextDropTimestamp: null,
      legacyDmClosed: false
    });
    expect(inspected.allowed).toBe(true);

    const { useCase } = createUseCase({
      wave,
      blockedUntil: null,
      replyTargetVisible: true
    });
    // The write path re-reads membership at execution time: now empty.
    await expect(
      runWriteGates(useCase, wave, createChatDropModel(), [])
    ).rejects.toMatchObject({
      code: WaveParticipationReasonCode.NOT_IN_CHAT_GROUP,
      message: 'User is not eligible for this wave'
    });
  });

  it('lets the atomic reservation override a stale cooldown decision', async () => {
    const wave = createWave({ chat_slow_mode_cooldown_ms: 60_000 });
    const inspected = evaluateWaveParticipationDecision({
      action: 'CHAT',
      wave: wave as any,
      identity: { profileId: AUTHOR, hasCreateDropRights: true },
      groupIdsUserIsEligibleFor: [CHAT_GROUP],
      nextDropTimestamp: IN_ONE_MINUTE(),
      legacyDmClosed: false
    });
    expect(inspected.reason_code).toBe(
      WaveParticipationReasonCode.SLOW_MODE_COOLDOWN
    );
    // By write time the reservation finds no active cooldown.
    const { useCase, wavesApiDb } = createUseCase({
      wave,
      blockedUntil: null,
      replyTargetVisible: true
    });
    await expect(
      runWriteGates(useCase, wave, createChatDropModel(), [CHAT_GROUP])
    ).resolves.toBeUndefined();
    expect(wavesApiDb.reserveWaveChatDropCooldown).toHaveBeenCalledTimes(1);
  });

  it('keeps reply target visibility as payload validation outside the decision', async () => {
    const wave = createWave({ chat_replies_open: true });
    const inspected = evaluateWaveParticipationDecision({
      action: 'REPLY',
      wave: wave as any,
      identity: { profileId: AUTHOR, hasCreateDropRights: true },
      groupIdsUserIsEligibleFor: [],
      nextDropTimestamp: null,
      legacyDmClosed: false
    });
    expect(inspected.allowed).toBe(true);

    const { useCase } = createUseCase({
      wave,
      blockedUntil: null,
      replyTargetVisible: false
    });
    const run = runWriteGates(
      useCase,
      wave,
      createChatDropModel({ reply_to: REPLY_TO }),
      []
    );
    await expect(run).rejects.toThrow('User is not eligible for this wave');
    await run.catch((error: CustomApiCompliantException) =>
      expect(error.code).toBeUndefined()
    );
  });

  it('keeps the slow mode message built from the reserved timestamp', async () => {
    const wave = createWave({ chat_slow_mode_cooldown_ms: 60_000 });
    const blockedUntil = IN_ONE_MINUTE();
    const { useCase } = createUseCase({
      wave,
      blockedUntil,
      replyTargetVisible: true
    });
    await expect(
      runWriteGates(useCase, wave, createChatDropModel(), [CHAT_GROUP])
    ).rejects.toMatchObject({
      code: WaveParticipationReasonCode.SLOW_MODE_COOLDOWN,
      message: `Slow mode is enabled. You can create your next chat drop at ${blockedUntil}`
    });
  });

  it('leaves participatory drops on the participation group gate', async () => {
    const wave = createWave({
      type: WaveType.RANK,
      participation_group_id: 'participants'
    });
    const { useCase } = createUseCase({
      wave,
      blockedUntil: null,
      replyTargetVisible: true
    });
    const run = (useCase as any).verifyWaveLimitations(
      {
        isDescriptionDrop: false,
        model: createChatDropModel({ drop_type: DropType.PARTICIPATORY }),
        groupIdsUserIsEligibleFor: [],
        preExistingGroupMentions: []
      },
      { connection: {} }
    );
    await expect(run).rejects.toThrow('User is not eligible for this wave');
    await run.catch((error: CustomApiCompliantException) =>
      expect(error.code).toBeUndefined()
    );
  });
});

describe('throwIfWaveParticipationDenied', () => {
  const constraints = {
    chat_enabled: true,
    chat_group_required: true,
    replies_open: false
  };

  it('does nothing for an allowed decision', () => {
    expect(() =>
      throwIfWaveParticipationDenied({
        action: 'CHAT',
        allowed: true,
        constraints,
        evaluation: 'EVALUATED'
      })
    ).not.toThrow();
  });

  it('maps an unavailable evaluation to the membership 503', () => {
    try {
      throwIfWaveParticipationDenied({
        action: 'CHAT',
        allowed: false,
        constraints,
        evaluation: 'UNAVAILABLE'
      });
      fail('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CustomApiCompliantException);
      expect((error as CustomApiCompliantException).getStatusCode()).toBe(503);
      expect((error as CustomApiCompliantException).code).toBeUndefined();
    }
  });

  it.each([
    [
      WaveParticipationReasonCode.NOT_AUTHENTICATED,
      'You need to create a profile before you can create a drop'
    ],
    [
      WaveParticipationReasonCode.PROXY_LACKS_ACTION,
      `Proxy doesn't have permission to create drops`
    ],
    [
      WaveParticipationReasonCode.NOT_IN_CHAT_GROUP,
      'User is not eligible for this wave'
    ],
    [
      WaveParticipationReasonCode.CHAT_DISABLED,
      'Chat drops are not allowed in this wave'
    ]
  ])('throws 403 with the existing message for %s', (reasonCode, message) => {
    try {
      throwIfWaveParticipationDenied({
        action: 'CHAT',
        allowed: false,
        reason_code: reasonCode,
        constraints,
        evaluation: 'EVALUATED'
      });
      fail('expected to throw');
    } catch (error) {
      const exception = error as CustomApiCompliantException;
      expect(exception.getStatusCode()).toBe(403);
      expect(exception.message).toBe(message);
      expect(exception.code).toBe(reasonCode);
    }
  });
});
