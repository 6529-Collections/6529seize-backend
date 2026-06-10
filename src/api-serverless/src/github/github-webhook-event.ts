export type GitHubWebhookAction = 'opened' | 'reopened';
export type GitHubWebhookKind = 'issue' | 'pull_request';
export type GitHubWebhookKindLabel = 'issue' | 'pull request';

export interface GitHubWebhookEvent {
  readonly kind: GitHubWebhookKind;
  readonly action: GitHubWebhookAction;
  readonly htmlUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSupportedAction(value: unknown): value is GitHubWebhookAction {
  return value === 'opened' || value === 'reopened';
}

function normalizeHtmlUrl(value: unknown): string | null {
  const htmlUrl = normalizeString(value);
  if (!htmlUrl) {
    return null;
  }

  try {
    const parsed = new URL(htmlUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? htmlUrl
      : null;
  } catch {
    return null;
  }
}

function getKindFromEventName(eventName: string): GitHubWebhookKind | null {
  if (eventName === 'issues') {
    return 'issue';
  }

  if (eventName === 'pull_request') {
    return 'pull_request';
  }

  return null;
}

function inferKindFromPayload(
  payload: Record<string, unknown>
): GitHubWebhookKind | null {
  if (isRecord(payload.pull_request)) {
    return 'pull_request';
  }

  if (isRecord(payload.issue)) {
    return 'issue';
  }

  return null;
}

function getTargetPayload(
  payload: Record<string, unknown>,
  kind: GitHubWebhookKind
): Record<string, unknown> | null {
  const target = kind === 'pull_request' ? payload.pull_request : payload.issue;
  return isRecord(target) ? target : null;
}

export function parseGitHubWebhookEvent(
  payload: unknown,
  eventName: unknown
): GitHubWebhookEvent | null {
  if (!isRecord(payload) || !isSupportedAction(payload.action)) {
    return null;
  }

  const normalizedEventName = normalizeString(eventName);
  const kind = normalizedEventName
    ? getKindFromEventName(normalizedEventName)
    : inferKindFromPayload(payload);
  if (!kind) {
    return null;
  }

  const targetPayload = getTargetPayload(payload, kind);
  const htmlUrl = targetPayload
    ? normalizeHtmlUrl(targetPayload.html_url)
    : null;
  if (!htmlUrl) {
    return null;
  }

  return {
    kind,
    action: payload.action,
    htmlUrl
  };
}

export function buildGitHubWebhookDedupeKey(
  event: GitHubWebhookEvent,
  deliveryId: unknown
): string {
  const normalizedDeliveryId = normalizeString(deliveryId);
  if (normalizedDeliveryId) {
    return `gh-webhook:delivery:${normalizedDeliveryId}`;
  }

  return `gh-webhook:${event.kind}:${event.action}:${event.htmlUrl}`;
}

export function formatGitHubWebhookKind(
  kind: GitHubWebhookKind
): GitHubWebhookKindLabel {
  return kind === 'pull_request' ? 'pull request' : 'issue';
}
