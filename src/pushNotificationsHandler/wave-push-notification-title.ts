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
  participantCount
}: {
  readonly waveName: string;
  readonly isDirectMessage: boolean;
  readonly participantCount: number;
}): WavePushNotificationContext {
  if (!isDirectMessage) {
    return { kind: 'wave', label: waveName };
  }

  if (participantCount <= 2) {
    return { kind: 'dm', label: 'DM' };
  }
  return { kind: 'group-dm', label: 'Group DM' };
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
