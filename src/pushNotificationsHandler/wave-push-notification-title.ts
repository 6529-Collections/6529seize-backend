import { formatSignedLocaleNumber } from '@/pushNotificationsHandler/drop-vote-push-notification-text';

export type WavePushNotificationContext = {
  readonly kind: 'wave' | 'dm' | 'group-dm';
  readonly label: string;
};

type WavePushNotificationAction =
  | { readonly type: 'message' }
  | { readonly type: 'reply' }
  | { readonly type: 'mention' }
  | { readonly type: 'quote' }
  | { readonly type: 'reaction'; readonly reaction: string }
  | { readonly type: 'invite' };

const normalizeHandle = (handle: string | null | undefined): string | null => {
  const trimmed = handle?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
};

function getUniqueParticipantHandles(
  participantHandles: readonly (string | null)[]
): string[] {
  const handlesByNormalizedHandle = new Map<string, string>();
  participantHandles.forEach((handle) => {
    const trimmedHandle = handle?.trim();
    const normalizedHandle = normalizeHandle(trimmedHandle);
    if (trimmedHandle && normalizedHandle) {
      handlesByNormalizedHandle.set(normalizedHandle, trimmedHandle);
    }
  });
  return Array.from(handlesByNormalizedHandle.values());
}

function getMessageVerb(context: WavePushNotificationContext): string {
  if (context.kind === 'wave') {
    return 'posted';
  }
  if (context.kind === 'dm') {
    return 'messaged you';
  }
  return 'messaged';
}

function parseRatingVote(value: unknown): number | null {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || value.trim() === '')
  ) {
    return null;
  }
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function buildWavePushNotificationContext({
  waveName,
  isDirectMessage,
  participantHandles,
  participantCount,
  actorHandle,
  recipientHandle
}: {
  readonly waveName: string;
  readonly isDirectMessage: boolean;
  readonly participantHandles: readonly (string | null)[];
  readonly participantCount: number;
  readonly actorHandle: string;
  readonly recipientHandle: string | null;
}): WavePushNotificationContext {
  if (!isDirectMessage) {
    return { kind: 'wave', label: waveName };
  }

  const normalizedActorHandle = normalizeHandle(actorHandle);
  const normalizedRecipientHandle = normalizeHandle(recipientHandle);
  const uniqueParticipantHandles =
    getUniqueParticipantHandles(participantHandles);

  if (participantCount <= 2) {
    return { kind: 'dm', label: 'DM' };
  }

  const otherParticipantHandles = uniqueParticipantHandles.filter((handle) => {
    const normalized = normalizeHandle(handle);
    return (
      normalized !== normalizedActorHandle &&
      normalized !== normalizedRecipientHandle
    );
  });
  const firstOtherParticipant = otherParticipantHandles[0];
  if (!firstOtherParticipant) {
    return { kind: 'group-dm', label: 'Group DM' };
  }

  const additionalParticipantCount = otherParticipantHandles.length - 1;
  const countSuffix =
    additionalParticipantCount > 0 ? ` +${additionalParticipantCount}` : '';
  return {
    kind: 'group-dm',
    label: `Group DM with ${firstOtherParticipant}${countSuffix}`
  };
}

export function buildWavePushNotificationTitle({
  actorHandle,
  action,
  context
}: {
  readonly actorHandle: string;
  readonly action: WavePushNotificationAction;
  readonly context: WavePushNotificationContext;
}): string {
  switch (action.type) {
    case 'message': {
      const verb = getMessageVerb(context);
      return `${actorHandle} ${verb} · ${context.label}`;
    }
    case 'reply':
      return `${actorHandle} replied · ${context.label}`;
    case 'mention':
      return `${actorHandle} mentioned you · ${context.label}`;
    case 'quote':
      return `${actorHandle} quoted you · ${context.label}`;
    case 'reaction':
      return `${actorHandle} reacted ${action.reaction} · ${context.label}`;
    case 'invite':
      if (context.kind === 'dm') {
        return `${actorHandle} started a DM`;
      }
      return context.kind === 'group-dm'
        ? `${actorHandle} added you · ${context.label}`
        : `${actorHandle} invited you · ${context.label}`;
  }
}

export function buildAllDropsPushNotificationTitle({
  actorHandle,
  vote,
  context
}: {
  readonly actorHandle: string;
  readonly vote: unknown;
  readonly context: WavePushNotificationContext;
}): string {
  const parsedVote = parseRatingVote(vote);
  if (parsedVote !== null) {
    return appendWavePushNotificationContext(
      `${actorHandle} rated a drop: ${formatSignedLocaleNumber(parsedVote)}`,
      context
    );
  }
  return buildWavePushNotificationTitle({
    actorHandle,
    action: { type: 'message' },
    context
  });
}

export function appendWavePushNotificationContext(
  title: string,
  context: WavePushNotificationContext
): string {
  return `${title} · ${context.label}`;
}
