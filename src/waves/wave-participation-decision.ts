import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { WaveEntity } from '@/entities/IWave';
import { Time } from '@/time';
import {
  canReplyInWaveChat,
  isWaveChatGroupMember
} from '@/waves/wave-chat-replies.helpers';
import {
  isWaveChatSlowModeActive,
  resolveNextDropAllowed
} from '@/waves/wave-chat-slow-mode.helpers';

/**
 * Pure participation policy for wave chat. The same decision backs the
 * `authenticated_user_eligible` style booleans, the drop write path and
 * `GET /waves/{id}/participation`, so an explanation can never drift from
 * enforcement. No I/O happens here; callers gather the inputs.
 *
 * Deliberately outside the decision:
 * - visibility: a hidden wave is a 404 at the API edge (`assertWaveAndParent
 *   VisibleOrThrow`), never a reason code, and the write path does not check
 *   it directly either;
 * - payload-specific validation (reply target visibility, links, signatures,
 *   content limits, moderation): `allowed: true` is not a promise that every
 *   payload is accepted;
 * - the atomic cooldown reservation: `reserveWaveChatDropCooldown` stays the
 *   source of truth at write time; `retry_at` here is the best current view.
 */
export type WaveParticipationAction = 'CHAT' | 'REPLY';

export const WAVE_PARTICIPATION_ACTIONS: readonly WaveParticipationAction[] = [
  'CHAT',
  'REPLY'
];

export enum WaveParticipationReasonCode {
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  PROXY_LACKS_ACTION = 'PROXY_LACKS_ACTION',
  NOT_IN_CHAT_GROUP = 'NOT_IN_CHAT_GROUP',
  CHAT_DISABLED = 'CHAT_DISABLED',
  LEGACY_DM_CLOSED = 'LEGACY_DM_CLOSED',
  SLOW_MODE_COOLDOWN = 'SLOW_MODE_COOLDOWN'
}

export type WaveParticipationEvaluation = 'EVALUATED' | 'UNAVAILABLE';

/** Only facts the wave already shows to everyone who can view it. */
export type WaveParticipationConstraints = {
  readonly chat_enabled: boolean;
  readonly chat_group_required: boolean;
  readonly replies_open: boolean;
  readonly slow_mode_cooldown_ms?: number;
};

export type WaveParticipationDecision = {
  readonly action: WaveParticipationAction;
  readonly allowed: boolean;
  readonly reason_code?: WaveParticipationReasonCode;
  readonly constraints: WaveParticipationConstraints;
  /** Epoch milliseconds at which the slow-mode cooldown lifts. */
  readonly retry_at?: number;
  readonly evaluation: WaveParticipationEvaluation;
};

export type WaveParticipationWave = Pick<
  WaveEntity,
  | 'chat_enabled'
  | 'chat_group_id'
  | 'chat_replies_open'
  | 'chat_slow_mode_cooldown_ms'
  | 'created_by'
  | 'admin_group_id'
> & { readonly visibility_group_id?: string | null };

export type WaveParticipationIdentity = {
  /** The acting profile (the proxied identity when acting as a proxy). */
  readonly profileId: string | null;
  /** `AuthenticationContext.hasRightsTo(CREATE_DROP_TO_WAVE)`. */
  readonly hasCreateDropRights: boolean;
};

export type WavePolicyDecisionInput = {
  readonly action: WaveParticipationAction;
  readonly wave: WaveParticipationWave;
  readonly authenticatedProfileId: string | null | undefined;
  readonly groupIdsUserIsEligibleFor: readonly string[];
  /** The identity's `wave_chat_drop_cooldowns.next_drop_timestamp`, if any. */
  readonly nextDropTimestamp: number | null | undefined;
  /** `isLegacyDmClosed(now)` for unencrypted DM waves, false otherwise. */
  readonly legacyDmClosed: boolean;
  readonly now?: number;
};

export type WaveParticipationDecisionInput = Omit<
  WavePolicyDecisionInput,
  'authenticatedProfileId' | 'groupIdsUserIsEligibleFor'
> & {
  readonly identity: WaveParticipationIdentity;
  /** `null` when membership could not be evaluated (the service's 503). */
  readonly groupIdsUserIsEligibleFor: readonly string[] | null;
};

export function waveParticipationIdentityFromAuthContext(
  authenticationContext: AuthenticationContext | undefined
): WaveParticipationIdentity {
  if (!authenticationContext?.isUserFullyAuthenticated()) {
    return { profileId: null, hasCreateDropRights: false };
  }
  return {
    profileId: authenticationContext.getActingAsId(),
    hasCreateDropRights: authenticationContext.hasRightsTo(
      ProfileProxyActionType.CREATE_DROP_TO_WAVE
    )
  };
}

export function resolveWaveParticipationConstraints(
  wave: WaveParticipationWave
): WaveParticipationConstraints {
  const constraints: WaveParticipationConstraints = {
    chat_enabled: wave.chat_enabled,
    chat_group_required: wave.chat_group_id !== null,
    replies_open: wave.chat_replies_open
  };
  if (isWaveChatSlowModeActive(wave)) {
    return {
      ...constraints,
      slow_mode_cooldown_ms: wave.chat_slow_mode_cooldown_ms!
    };
  }
  return constraints;
}

function denied(
  action: WaveParticipationAction,
  constraints: WaveParticipationConstraints,
  reasonCode: WaveParticipationReasonCode,
  retryAt?: number
): WaveParticipationDecision {
  const decision: WaveParticipationDecision = {
    action,
    allowed: false,
    reason_code: reasonCode,
    constraints,
    evaluation: 'EVALUATED'
  };
  return retryAt === undefined ? decision : { ...decision, retry_at: retryAt };
}

/**
 * The chat group gates top-level drops. Replies follow the group unless the
 * wave opens them to everyone who can view it (`canReplyInWaveChat`).
 */
function passesChatGroupGate({
  action,
  wave,
  groupIdsUserIsEligibleFor
}: Pick<
  WavePolicyDecisionInput,
  'action' | 'wave' | 'groupIdsUserIsEligibleFor'
>): boolean {
  if (isWaveChatGroupMember({ wave, groupIdsUserIsEligibleFor })) {
    return true;
  }
  return (
    action === 'REPLY' &&
    canReplyInWaveChat({ wave, groupIdsUserIsEligibleFor })
  );
}

/**
 * Policy-level decision in the write path's order: chat group, chat enabled,
 * unencrypted DM cutoff, slow mode. Identity gates (anonymous, proxy rights)
 * and membership availability are layered on by
 * `evaluateWaveParticipationDecision`; the existing wave booleans never
 * expressed them, so they derive from this function directly.
 */
export function evaluateWavePolicyDecision(
  input: WavePolicyDecisionInput
): WaveParticipationDecision {
  const { action, wave, authenticatedProfileId, groupIdsUserIsEligibleFor } =
    input;
  const constraints = resolveWaveParticipationConstraints(wave);
  if (!passesChatGroupGate(input)) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.NOT_IN_CHAT_GROUP
    );
  }
  if (!wave.chat_enabled) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.CHAT_DISABLED
    );
  }
  if (input.legacyDmClosed) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.LEGACY_DM_CLOSED
    );
  }
  const retryAt = resolveNextDropAllowed({
    wave,
    authenticatedProfileId,
    groupIdsUserIsEligibleFor,
    nextDropTimestamp: input.nextDropTimestamp,
    now: input.now
  });
  if (retryAt !== undefined) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.SLOW_MODE_COOLDOWN,
      retryAt
    );
  }
  return { action, allowed: true, constraints, evaluation: 'EVALUATED' };
}

/** Both actions from one input, sharing a single `now`. */
export function evaluateWavePolicyDecisions(
  input: Omit<WavePolicyDecisionInput, 'action'>
): Record<WaveParticipationAction, WaveParticipationDecision> {
  const now = input.now ?? Time.currentMillis();
  return {
    CHAT: evaluateWavePolicyDecision({ ...input, action: 'CHAT', now }),
    REPLY: evaluateWavePolicyDecision({ ...input, action: 'REPLY', now })
  };
}

/**
 * Full decision for an identity: anonymous and proxy gates first (the drop
 * route rejects those before touching membership), then membership
 * availability, then the shared policy. An unavailable membership service
 * is reported as `UNAVAILABLE`, never as a denial with a reason.
 */
export function evaluateWaveParticipationDecision(
  input: WaveParticipationDecisionInput
): WaveParticipationDecision {
  const { action, wave, identity, groupIdsUserIsEligibleFor } = input;
  const constraints = resolveWaveParticipationConstraints(wave);
  if (!identity.profileId) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.NOT_AUTHENTICATED
    );
  }
  if (!identity.hasCreateDropRights) {
    return denied(
      action,
      constraints,
      WaveParticipationReasonCode.PROXY_LACKS_ACTION
    );
  }
  if (groupIdsUserIsEligibleFor === null) {
    return { action, allowed: false, constraints, evaluation: 'UNAVAILABLE' };
  }
  return evaluateWavePolicyDecision({
    action,
    wave,
    authenticatedProfileId: identity.profileId,
    groupIdsUserIsEligibleFor,
    nextDropTimestamp: input.nextDropTimestamp,
    legacyDmClosed: input.legacyDmClosed,
    now: input.now
  });
}

export function evaluateWaveParticipationDecisions(
  input: Omit<WaveParticipationDecisionInput, 'action'>
): WaveParticipationDecision[] {
  const now = input.now ?? Time.currentMillis();
  return WAVE_PARTICIPATION_ACTIONS.map((action) =>
    evaluateWaveParticipationDecision({ ...input, action, now })
  );
}
