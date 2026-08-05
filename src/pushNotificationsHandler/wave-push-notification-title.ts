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

export function buildWavePushNotificationContext({
  waveName,
  isDirectMessage,
  participantHandles,
  actorHandle,
  recipientHandle
}: {
  readonly waveName: string;
  readonly isDirectMessage: boolean;
  readonly participantHandles: readonly (string | null)[];
  readonly actorHandle: string;
  readonly recipientHandle: string | null;
}): WavePushNotificationContext {
  if (!isDirectMessage) {
    return { kind: 'wave', label: waveName };
  }

  const normalizedActorHandle = normalizeHandle(actorHandle);
  const normalizedRecipientHandle = normalizeHandle(recipientHandle);
  const uniqueParticipantHandles = Array.from(
    new Map(
      participantHandles.flatMap((handle) => {
        const normalized = normalizeHandle(handle);
        return normalized && handle?.trim()
          ? [[normalized, handle.trim()] as const]
          : [];
      })
    ).values()
  );

  if (uniqueParticipantHandles.length <= 2) {
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
      const verb =
        context.kind === 'wave'
          ? 'posted'
          : context.kind === 'dm'
            ? 'messaged you'
            : 'messaged';
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

export function appendWavePushNotificationContext(
  title: string,
  context: WavePushNotificationContext
): string {
  return `${title} · ${context.label}`;
}
