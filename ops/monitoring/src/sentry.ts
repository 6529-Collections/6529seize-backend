import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Alert,
  EVENT_TYPE,
  Environment,
  hash,
  record,
  token
} from './contract.js';

export function verifySignature(
  body: Buffer,
  signature: string,
  secret: string
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
export function sentryAlert(
  payload: unknown,
  environment: Environment,
  projects: string[]
): Alert | null {
  const body = record(payload);
  if (body.action !== 'triggered' && body.action !== 'created') return null;
  const data = record(body.data);
  const event = record(data.event ?? data.error);
  const project = [
    record(data.project).slug,
    record(data.project).id,
    event.project_slug,
    record(event.project).slug,
    record(event.project).id,
    event.project
  ]
    .map((value) =>
      token(typeof value === 'number' ? String(value) : value, 80)
    )
    .find((value) => value !== undefined && projects.includes(value));
  const eventId = token(event.event_id ?? event.id, 64);
  if (!project || !projects.includes(project) || !eventId)
    throw new Error('INVALID_SENTRY_EVENT');
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const environmentTag = tags.find(
    (tag) => Array.isArray(tag) && tag[0] === 'environment'
  );
  const sourceEnvironment =
    event.environment ??
    (Array.isArray(environmentTag) ? environmentTag[1] : undefined);
  const normalized =
    sourceEnvironment === 'production' ? 'prod' : sourceEnvironment;
  // The same Sentry integration may route several environments; never relabel one as another.
  if (normalized !== environment) return null;
  // Vendor severity/message/user metadata cannot choose the protected critical lane.
  const issue = record(data.issue).id ?? event.issue_id ?? event.groupID;
  const issueId =
    token(typeof issue === 'number' ? String(issue) : issue) ?? eventId;
  return {
    _type: EVENT_TYPE,
    eventId: `sentry:${project}:${eventId}`,
    occurredAt: new Date().toISOString(),
    environment,
    service: `sentry.${project}`,
    severity: 'error',
    code: 'SENTRY_ERROR',
    fingerprint: hash(`sentry:${project}:${issueId}`)
  };
}
