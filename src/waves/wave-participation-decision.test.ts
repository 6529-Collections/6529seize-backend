import fc from 'fast-check';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { LEGACY_DM_CLOSED_CODE } from '@/legacy-dm/legacy-dm-retention';
import { canReplyInWaveChat } from '@/waves/wave-chat-replies.helpers';
import { resolveNextDropAllowed } from '@/waves/wave-chat-slow-mode.helpers';
import {
  evaluateWaveParticipationDecision,
  evaluateWaveParticipationDecisions,
  evaluateWavePolicyDecision,
  evaluateWavePolicyDecisions,
  WAVE_PARTICIPATION_ACTIONS,
  WaveParticipationAction,
  WaveParticipationDecisionInput,
  WaveParticipationReasonCode,
  WaveParticipationWave,
  waveParticipationIdentityFromAuthContext
} from './wave-participation-decision';

const NOW = 1_000_000;
const CHAT_GROUP = 'chat-group';
const ADMIN_GROUP = 'admin-group';

function wave(
  overrides: Partial<WaveParticipationWave> = {}
): WaveParticipationWave {
  return {
    chat_enabled: true,
    chat_group_id: CHAT_GROUP,
    chat_replies_open: false,
    chat_slow_mode_cooldown_ms: null,
    created_by: 'creator',
    admin_group_id: ADMIN_GROUP,
    visibility_group_id: null,
    ...overrides
  };
}

const member = { profileId: 'member', hasCreateDropRights: true };

function decide(
  action: WaveParticipationAction,
  overrides: Partial<WaveParticipationDecisionInput> = {}
) {
  return evaluateWaveParticipationDecision({
    action,
    wave: wave(),
    identity: member,
    groupIdsUserIsEligibleFor: [CHAT_GROUP],
    nextDropTimestamp: null,
    legacyDmClosed: false,
    now: NOW,
    ...overrides
  });
}

describe('evaluateWaveParticipationDecision', () => {
  it('keeps the legacy DM code identical to the write path constant', () => {
    expect(WaveParticipationReasonCode.LEGACY_DM_CLOSED).toBe(
      LEGACY_DM_CLOSED_CODE
    );
  });

  it('allows a chat group member to chat and reply', () => {
    for (const action of WAVE_PARTICIPATION_ACTIONS) {
      expect(decide(action)).toEqual({
        action,
        allowed: true,
        constraints: {
          chat_enabled: true,
          chat_group_required: true,
          replies_open: false
        },
        evaluation: 'EVALUATED'
      });
    }
  });

  it('denies anonymous callers before anything else', () => {
    const decision = decide('CHAT', {
      identity: { profileId: null, hasCreateDropRights: false },
      groupIdsUserIsEligibleFor: null,
      wave: wave({ chat_enabled: false })
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason_code).toBe(
      WaveParticipationReasonCode.NOT_AUTHENTICATED
    );
    expect(decision.evaluation).toBe('EVALUATED');
  });

  it('denies a proxy without the create-drop action', () => {
    const decision = decide('REPLY', {
      identity: { profileId: 'proxied', hasCreateDropRights: false }
    });
    expect(decision.reason_code).toBe(
      WaveParticipationReasonCode.PROXY_LACKS_ACTION
    );
  });

  it('reports membership outages as UNAVAILABLE, never as a denial reason', () => {
    const decision = decide('CHAT', { groupIdsUserIsEligibleFor: null });
    expect(decision).toEqual({
      action: 'CHAT',
      allowed: false,
      constraints: {
        chat_enabled: true,
        chat_group_required: true,
        replies_open: false
      },
      evaluation: 'UNAVAILABLE'
    });
  });

  it('requires the chat group for top-level drops even with open replies', () => {
    const decision = decide('CHAT', {
      wave: wave({ chat_replies_open: true }),
      groupIdsUserIsEligibleFor: []
    });
    expect(decision.reason_code).toBe(
      WaveParticipationReasonCode.NOT_IN_CHAT_GROUP
    );
  });

  it('lets outsiders reply only when replies are open', () => {
    expect(
      decide('REPLY', {
        wave: wave({ chat_replies_open: true }),
        groupIdsUserIsEligibleFor: []
      }).allowed
    ).toBe(true);
    expect(decide('REPLY', { groupIdsUserIsEligibleFor: [] }).reason_code).toBe(
      WaveParticipationReasonCode.NOT_IN_CHAT_GROUP
    );
  });

  it('allows everyone when no chat group is configured', () => {
    const decision = decide('CHAT', {
      wave: wave({ chat_group_id: null }),
      groupIdsUserIsEligibleFor: []
    });
    expect(decision.allowed).toBe(true);
    expect(decision.constraints.chat_group_required).toBe(false);
  });

  it('reports CHAT_DISABLED after the group gate, like the write path', () => {
    expect(
      decide('CHAT', { wave: wave({ chat_enabled: false }) }).reason_code
    ).toBe(WaveParticipationReasonCode.CHAT_DISABLED);
    // Outsider with open replies but chat disabled: the write path's group
    // gate fires first because open replies need chat to be enabled.
    expect(
      decide('REPLY', {
        wave: wave({ chat_enabled: false, chat_replies_open: true }),
        groupIdsUserIsEligibleFor: []
      }).reason_code
    ).toBe(WaveParticipationReasonCode.NOT_IN_CHAT_GROUP);
  });

  it('denies closed unencrypted DMs', () => {
    expect(decide('CHAT', { legacyDmClosed: true }).reason_code).toBe(
      WaveParticipationReasonCode.LEGACY_DM_CLOSED
    );
  });

  describe('slow mode', () => {
    const slowWave = wave({ chat_slow_mode_cooldown_ms: 60_000 });

    it('exposes the cooldown as a constraint', () => {
      expect(decide('CHAT', { wave: slowWave }).constraints).toEqual({
        chat_enabled: true,
        chat_group_required: true,
        replies_open: false,
        slow_mode_cooldown_ms: 60_000
      });
    });

    it('denies with retry_at while the cooldown is active', () => {
      const decision = decide('CHAT', {
        wave: slowWave,
        nextDropTimestamp: NOW + 5_000
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason_code).toBe(
        WaveParticipationReasonCode.SLOW_MODE_COOLDOWN
      );
      expect(decision.retry_at).toBe(NOW + 5_000);
    });

    it('allows once the cooldown has expired', () => {
      const decision = decide('CHAT', {
        wave: slowWave,
        nextDropTimestamp: NOW
      });
      expect(decision.allowed).toBe(true);
      expect(decision.retry_at).toBeUndefined();
    });

    it('exempts the creator and admins', () => {
      expect(
        decide('CHAT', {
          wave: slowWave,
          identity: { profileId: 'creator', hasCreateDropRights: true },
          nextDropTimestamp: NOW + 5_000
        }).allowed
      ).toBe(true);
      expect(
        decide('CHAT', {
          wave: slowWave,
          groupIdsUserIsEligibleFor: [CHAT_GROUP, ADMIN_GROUP],
          nextDropTimestamp: NOW + 5_000
        }).allowed
      ).toBe(true);
    });

    it('applies to open repliers outside the chat group', () => {
      const decision = decide('REPLY', {
        wave: { ...slowWave, chat_replies_open: true },
        groupIdsUserIsEligibleFor: [],
        nextDropTimestamp: NOW + 5_000
      });
      expect(decision.reason_code).toBe(
        WaveParticipationReasonCode.SLOW_MODE_COOLDOWN
      );
    });

    it('never reports a cooldown on an action blocked by an earlier gate', () => {
      const decision = decide('CHAT', {
        wave: { ...slowWave, chat_replies_open: true },
        groupIdsUserIsEligibleFor: [],
        nextDropTimestamp: NOW + 5_000
      });
      expect(decision.reason_code).toBe(
        WaveParticipationReasonCode.NOT_IN_CHAT_GROUP
      );
      expect(decision.retry_at).toBeUndefined();
    });
  });

  it('evaluates both actions with one shared clock', () => {
    const decisions = evaluateWaveParticipationDecisions({
      wave: wave({ chat_replies_open: true }),
      identity: member,
      groupIdsUserIsEligibleFor: [],
      nextDropTimestamp: null,
      legacyDmClosed: false,
      now: NOW
    });
    expect(decisions.map((it) => [it.action, it.allowed])).toEqual([
      ['CHAT', false],
      ['REPLY', true]
    ]);
  });
});

describe('waveParticipationIdentityFromAuthContext', () => {
  it('treats missing or anonymous contexts as unauthenticated', () => {
    expect(waveParticipationIdentityFromAuthContext(undefined)).toEqual({
      profileId: null,
      hasCreateDropRights: false
    });
    expect(
      waveParticipationIdentityFromAuthContext(
        AuthenticationContext.notAuthenticated()
      )
    ).toEqual({ profileId: null, hasCreateDropRights: false });
  });

  it('uses the acting profile and the create-drop proxy right', () => {
    const proxyWithout = new AuthenticationContext({
      authenticatedWallet: '0xabc',
      authenticatedProfileId: 'proxy',
      roleProfileId: 'owner',
      activeProxyActions: []
    });
    expect(waveParticipationIdentityFromAuthContext(proxyWithout)).toEqual({
      profileId: 'owner',
      hasCreateDropRights: false
    });
    const proxyWith = new AuthenticationContext({
      authenticatedWallet: '0xabc',
      authenticatedProfileId: 'proxy',
      roleProfileId: 'owner',
      activeProxyActions: [
        {
          id: 'a',
          type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
          credit_amount: null,
          credit_spent: null
        }
      ]
    });
    expect(waveParticipationIdentityFromAuthContext(proxyWith)).toEqual({
      profileId: 'owner',
      hasCreateDropRights: true
    });
    expect(
      waveParticipationIdentityFromAuthContext(
        AuthenticationContext.fromProfileId('me')
      )
    ).toEqual({ profileId: 'me', hasCreateDropRights: true });
  });
});

describe('evaluateWavePolicyDecision properties', () => {
  const groupArb = fc.constantFrom(null, CHAT_GROUP, 'other-group');
  const waveArb: fc.Arbitrary<WaveParticipationWave> = fc.record({
    chat_enabled: fc.boolean(),
    chat_group_id: groupArb,
    chat_replies_open: fc.boolean(),
    chat_slow_mode_cooldown_ms: fc.constantFrom(null, 0, 60_000),
    created_by: fc.constantFrom('creator', 'someone-else'),
    admin_group_id: fc.constantFrom(null, ADMIN_GROUP),
    visibility_group_id: fc.constantFrom(null, 'visible-group')
  });
  const groupsArb = fc.subarray([CHAT_GROUP, ADMIN_GROUP, 'visible-group']);
  const profileArb = fc.constantFrom(null, 'creator', 'member');
  const nextDropArb = fc.constantFrom(null, undefined, NOW - 1, NOW + 1);

  it('matches the existing helpers on allowed and retry_at', () => {
    fc.assert(
      fc.property(
        waveArb,
        groupsArb,
        profileArb,
        nextDropArb,
        fc.boolean(),
        (w, groups, profileId, nextDropTimestamp, legacyDmClosed) => {
          const nextDropAllowed = resolveNextDropAllowed({
            wave: w,
            authenticatedProfileId: profileId,
            groupIdsUserIsEligibleFor: groups,
            nextDropTimestamp,
            now: NOW
          });
          const inGroup =
            w.chat_group_id === null || groups.includes(w.chat_group_id);
          const decisions = evaluateWavePolicyDecisions({
            wave: w,
            authenticatedProfileId: profileId,
            groupIdsUserIsEligibleFor: groups,
            nextDropTimestamp,
            legacyDmClosed,
            now: NOW
          });
          expect(decisions.CHAT.allowed).toBe(
            inGroup &&
              w.chat_enabled &&
              !legacyDmClosed &&
              nextDropAllowed === undefined
          );
          expect(decisions.REPLY.allowed).toBe(
            canReplyInWaveChat({
              wave: w,
              groupIdsUserIsEligibleFor: groups
            }) &&
              !legacyDmClosed &&
              nextDropAllowed === undefined
          );
          if (!legacyDmClosed) {
            expect(decisions.REPLY.retry_at).toBe(nextDropAllowed);
          }
          for (const decision of [decisions.CHAT, decisions.REPLY]) {
            expect(decision.evaluation).toBe('EVALUATED');
            expect(decision.allowed).toBe(decision.reason_code === undefined);
            expect(decision.retry_at !== undefined).toBe(
              decision.reason_code ===
                WaveParticipationReasonCode.SLOW_MODE_COOLDOWN
            );
          }
        }
      )
    );
  });

  it('never yields identity reason codes at the policy level', () => {
    fc.assert(
      fc.property(waveArb, groupsArb, profileArb, (w, groups, profileId) => {
        const decision = evaluateWavePolicyDecision({
          action: 'CHAT',
          wave: w,
          authenticatedProfileId: profileId,
          groupIdsUserIsEligibleFor: groups,
          nextDropTimestamp: null,
          legacyDmClosed: false,
          now: NOW
        });
        expect([
          WaveParticipationReasonCode.NOT_AUTHENTICATED,
          WaveParticipationReasonCode.PROXY_LACKS_ACTION
        ]).not.toContain(decision.reason_code);
      })
    );
  });
});
