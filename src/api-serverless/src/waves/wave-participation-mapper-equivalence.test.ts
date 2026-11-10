import fc from 'fast-check';
import { WaveEntity } from '@/entities/IWave';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { canReplyInWaveChat } from '@/waves/wave-chat-replies.helpers';
import { resolveNextDropAllowed } from '@/waves/wave-chat-slow-mode.helpers';
import { ApiWaveOverviewMapper } from '@/api/waves/api-wave-overview.mapper';
import {
  mapWaveToApiWaveMin,
  WaveMinSource
} from '@/api/waves/wave-min.helpers';
import { WavesMappers } from '@/api/waves/waves.mappers';

/**
 * The wave booleans now derive from the shared participation decision. These
 * sweeps pin them to the formulas they replaced, so the public output stays
 * byte-identical for every wave configuration.
 */
const CHAT_GROUP = 'chat-group';
const ADMIN_GROUP = 'admin-group';
const VISIBILITY_GROUP = 'visible-group';
const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;
const FAR_PAST = 1;

type Sweep = {
  wave: WaveEntity;
  groups: string[];
  profileId: string | null;
  nextDropTimestamp: number | undefined;
};

const sweepArb: fc.Arbitrary<Sweep> = fc
  .record({
    chat_enabled: fc.boolean(),
    chat_group_id: fc.constantFrom(null, CHAT_GROUP, 'other-group'),
    chat_replies_open: fc.boolean(),
    chat_slow_mode_cooldown_ms: fc.constantFrom(null, 0, 60_000),
    admin_group_id: fc.constantFrom(null, ADMIN_GROUP),
    visibility_group_id: fc.constantFrom(null, VISIBILITY_GROUP),
    is_direct_message: fc.boolean(),
    groups: fc.subarray([CHAT_GROUP, ADMIN_GROUP, VISIBILITY_GROUP]),
    profile: fc.constantFrom<'creator' | 'member' | null>(
      'creator',
      'member',
      null
    ),
    nextDropTimestamp: fc.constantFrom(undefined, FAR_PAST, FAR_FUTURE)
  })
  .map(({ groups, profile, nextDropTimestamp, ...fields }) => {
    // The fixture serialises the JSON columns; the mapper expects arrays.
    const wave: WaveEntity = {
      ...aWave(
        { ...fields, created_by: 'creator' },
        { id: 'wave-1', name: 'Wave 1', serial_no: 1 }
      ),
      participation_required_metadata: [],
      participation_required_media: []
    };
    return {
      wave,
      groups,
      profileId: profile,
      nextDropTimestamp
    };
  });

function legacyBooleans({ wave, groups, profileId, nextDropTimestamp }: Sweep) {
  const canView =
    wave.visibility_group_id === null ||
    groups.includes(wave.visibility_group_id);
  const nextDropAllowed = resolveNextDropAllowed({
    wave,
    authenticatedProfileId: profileId,
    groupIdsUserIsEligibleFor: groups,
    nextDropTimestamp
  });
  const inChatGroup =
    wave.chat_group_id === null || groups.includes(wave.chat_group_id);
  const canReply = canReplyInWaveChat({
    wave,
    groupIdsUserIsEligibleFor: groups
  });
  return {
    canView,
    nextDropAllowed,
    chat:
      canView &&
      inChatGroup &&
      wave.chat_enabled &&
      nextDropAllowed === undefined,
    reply: canView && canReply && nextDropAllowed === undefined,
    overviewChat:
      wave.chat_enabled && inChatGroup && nextDropAllowed === undefined,
    overviewReply: canReply && nextDropAllowed === undefined,
    minChat: canView && wave.chat_enabled && inChatGroup,
    minReply: canView && canReply
  };
}

describe('wave participation decision mapper equivalence', () => {
  it('keeps ApiWave chat eligibility and next_drop_allowed unchanged', () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    fc.assert(
      fc.property(sweepArb, (sweep) => {
        const expected = legacyBooleans(sweep);
        const { wave, groups, profileId, nextDropTimestamp } = sweep;
        const mapped = (mapper as any).mapWaveEntityToApiWave({
          waveEntity: wave,
          relatedData: {
            contributors: {},
            profiles: { creator: { id: 'creator' } },
            curations: {},
            displayByWaveId: {},
            creationDrops: {
              [wave.description_drop_id]: { id: wave.description_drop_id }
            },
            subscribedActions: {},
            metrics: {
              'wave-1': {
                wave_id: 'wave-1',
                drops_count: 0,
                subscribers_count: 0,
                participatory_drops_count: 0,
                latest_drop_timestamp: 0
              }
            },
            authenticatedUserMetrics: {},
            authenticatedUserReaderMetrics: {},
            chatDropCooldowns:
              nextDropTimestamp === undefined
                ? {}
                : { 'wave-1': { next_drop_timestamp: nextDropTimestamp } },
            yourParticipationDropsCountByWaveId: {},
            yourUnreadDropsCountByWaveId: {},
            firstUnreadDropSerialNoByWaveId: {},
            wavePauses: {},
            decisionsDoneByWaveId: {},
            votingCreditNftsByWaveId: {},
            pinnedWaveIds: new Set<string>(),
            identityWaveIds: new Set<string>(),
            authenticatedUserId: profileId
          },
          noRightToVote: false,
          groupIdsUserIsEligibleFor: groups,
          noRightToParticipate: false
        });
        expect(mapped.chat.authenticated_user_eligible).toBe(expected.chat);
        expect(mapped.chat.replies.authenticated_user_eligible).toBe(
          expected.reply
        );
        expect(mapped.chat.next_drop_allowed).toBe(expected.nextDropAllowed);
        expect('next_drop_allowed' in mapped.chat).toBe(
          expected.nextDropAllowed !== undefined
        );
      })
    );
  });

  it('keeps ApiWaveOverview context can_chat, can_reply and next_drop_allowed unchanged', () => {
    const mapper = new ApiWaveOverviewMapper(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    fc.assert(
      fc.property(
        sweepArb.filter((it) => it.profileId !== null),
        (sweep) => {
          const expected = legacyBooleans(sweep);
          const context = (mapper as any).mapContextProfileContext({
            wave: sweep.wave,
            groupIdsUserIsEligibleFor: sweep.groups,
            subscribedActions: [],
            pinnedWaveIds: new Set<string>(),
            unreadDropsCount: 0,
            contextProfileId: sweep.profileId,
            nextDropTimestamp: sweep.nextDropTimestamp
          });
          expect(context.can_chat).toBe(expected.overviewChat);
          expect(context.can_reply).toBe(expected.overviewReply);
          expect(context.next_drop_allowed).toBe(expected.nextDropAllowed);
          expect('next_drop_allowed' in context).toBe(
            expected.nextDropAllowed !== undefined
          );
        }
      )
    );
  });

  it('keeps ApiWaveMin chat and reply eligibility unchanged', () => {
    fc.assert(
      fc.property(sweepArb, (sweep) => {
        const expected = legacyBooleans(sweep);
        const source: WaveMinSource = {
          ...sweep.wave,
          last_drop_time: 0
        };
        const mapped = mapWaveToApiWaveMin({
          wave: source,
          displayByWaveId: {},
          groupIdsUserIsEligibleFor: sweep.groups,
          noRightToVote: false,
          noRightToParticipate: false,
          pinned: false,
          identityWave: false,
          authenticatedProfileId: sweep.profileId
        });
        expect(mapped.authenticated_user_eligible_to_chat).toBe(
          expected.minChat
        );
        expect(mapped.authenticated_user_eligible_to_reply).toBe(
          expected.minReply
        );
      })
    );
  });
});
