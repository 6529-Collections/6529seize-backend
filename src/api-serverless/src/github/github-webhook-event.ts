export type GitHubWebhookAction = 'opened' | 'reopened' | 'merged';
export type GitHubWebhookKind = 'issue' | 'pull_request';
export type GitHubWebhookKindLabel = 'issue' | 'pull request';

export interface GitHubWebhookEvent {
  readonly kind: GitHubWebhookKind;
  readonly action: GitHubWebhookAction;
  readonly htmlUrl: string;
  readonly title?: string;
  readonly body?: string;
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

function isOpeningAction(
  value: unknown
): value is Extract<GitHubWebhookAction, 'opened' | 'reopened'> {
  return value === 'opened' || value === 'reopened';
}

function resolveWebhookAction(
  rawAction: unknown,
  kind: GitHubWebhookKind,
  targetPayload: Record<string, unknown>
): GitHubWebhookAction | null {
  if (isOpeningAction(rawAction)) {
    return rawAction;
  }

  if (
    rawAction === 'closed' &&
    kind === 'pull_request' &&
    targetPayload.merged === true
  ) {
    return 'merged';
  }

  return null;
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
  if (!isRecord(payload)) {
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
  if (!targetPayload) {
    return null;
  }

  const action = resolveWebhookAction(payload.action, kind, targetPayload);
  if (!action) {
    return null;
  }

  const htmlUrl = normalizeHtmlUrl(targetPayload.html_url);
  if (!htmlUrl) {
    return null;
  }

  return {
    kind,
    action,
    htmlUrl,
    ...buildOptionalWebhookTextFields(targetPayload)
  };
}

function buildOptionalWebhookTextFields(
  targetPayload: Record<string, unknown>
): Pick<GitHubWebhookEvent, 'title' | 'body'> {
  const title = normalizeString(targetPayload.title);
  const body = normalizeString(targetPayload.body);

  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {})
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
