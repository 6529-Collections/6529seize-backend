import { AuthenticationContext } from '@/auth-context';
import { PROFILES_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import { mergeCapabilities } from './artwork-documentation.access';
import { parseJson } from './artwork-documentation.db';
import { Capabilities } from './artwork-documentation.types';
import {
  AD_CONTEXTS,
  AD_EVENTS,
  AD_GRANTS
} from './artwork-documentation.tables';
import { digest, fail } from './artwork-documentation.validation';

const PROGRAM_ID = '6529NM-AP-01';
const ACTION = 'set_keys_and_gates_coordinator_read_access_v1';
const AUDIT_KIND = 'operator_coordinator_read_access';
export const COORDINATOR_READ_FLAGS = [
  'read_archival_files',
  'read_rights_evidence',
  'read_source_receipts',
  'read_contact',
  'read_restricted_fields'
] as const;
type ReadFlag = (typeof COORDINATOR_READ_FLAGS)[number];
type CoordinatorReadEvent = {
  correlation_id: string;
  coordinator_profile_id: string;
  apply: boolean;
};
type GrantRow = { id: string; capabilities_json: unknown };
type AppliedReference = { grant_id: string; changed_read_flags: ReadFlag[] };

export async function existingCoordinatorGrant(
  profileId: string,
  service: ArtworkDocumentationService,
  ctx: RequestContext,
  lock = false
) {
  const profile = await service.db.one<{ external_id: string }>(
    `SELECT external_id FROM ${PROFILES_TABLE} WHERE external_id=:id LIMIT 1`,
    { id: profileId },
    ctx
  );
  if (!profile) fail(422, 'COORDINATOR_PROFILE_NOT_FOUND');
  const rows = await service.db.query<GrantRow>(
    `SELECT id,capabilities_json FROM ${AD_GRANTS} WHERE context_id IS NULL AND program_id=:program AND subject_profile_id=:profile AND revoked_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    { program: PROGRAM_ID, profile: profileId },
    ctx
  );
  if (rows.length !== 1) fail(409, 'EXISTING_COORDINATOR_GRANT_REQUIRED');
  const row = rows[0];
  const stored = parseJson<Record<string, unknown> | null>(
    row.capabilities_json
  );
  if (
    !stored ||
    typeof stored !== 'object' ||
    Array.isArray(stored) ||
    stored.read_context !== true ||
    stored.manage_assignments !== true ||
    stored.manage_context !== true
  )
    fail(403, 'EXISTING_COORDINATOR_GRANT_REQUIRED');
  return { row, stored };
}

async function projectionSummary(
  profileId: string,
  service: ArtworkDocumentationService,
  ctx: RequestContext
) {
  const contexts = await service.db.query<{ id: string }>(
    `SELECT id FROM ${AD_CONTEXTS} WHERE program_id=:program ORDER BY id LIMIT 201`,
    { program: PROGRAM_ID },
    ctx
  );
  if (contexts.length > 200) fail(409, 'COORDINATOR_VERIFICATION_LIMIT');
  let redactedFieldCount = 0;
  const actorContext = {
    ...ctx,
    authenticationContext: AuthenticationContext.fromProfileId(profileId)
  };
  for (const context of contexts) {
    const access = await service.authorizeContext(context.id, actorContext);
    for (const module of Object.values(
      service.projectModules(access.context, access)
    ))
      redactedFieldCount += Object.values(module.answers).filter(
        (answer) => 'redacted' in answer
      ).length;
  }
  return {
    contexts_count: contexts.length,
    redacted_field_count: redactedFieldCount
  };
}

async function applyReadAccess(
  event: CoordinatorReadEvent,
  service: ArtworkDocumentationService,
  ctx: RequestContext
): Promise<AppliedReference> {
  const { row, stored } = await existingCoordinatorGrant(
    event.coordinator_profile_id,
    service,
    ctx,
    true
  );
  // This permanent audit also fences retries after transient idempotency expiry.
  const previous = await service.db.one<{
    kind: string;
    actor_profile_id: string;
    references_json: unknown;
  }>(
    `SELECT kind,actor_profile_id,references_json FROM ${AD_EVENTS} WHERE id=:id`,
    { id: event.correlation_id },
    ctx
  );
  if (previous) {
    const reference = parseJson<AppliedReference & { program_id: string }>(
      previous.references_json
    );
    if (
      previous.kind !== AUDIT_KIND ||
      previous.actor_profile_id !== event.coordinator_profile_id ||
      reference.program_id !== PROGRAM_ID ||
      reference.grant_id !== row.id
    )
      fail(409, 'IDEMPOTENCY_MISMATCH');
    return {
      grant_id: reference.grant_id,
      changed_read_flags: reference.changed_read_flags
    };
  }
  const changed = COORDINATOR_READ_FLAGS.filter((key) => stored[key] !== true);
  const updated = { ...stored };
  for (const key of COORDINATOR_READ_FLAGS) updated[key] = true;
  if (changed.length)
    await service.db.query(
      `UPDATE ${AD_GRANTS} SET capabilities_json=:capabilities WHERE id=:id`,
      { id: row.id, capabilities: JSON.stringify(updated) },
      ctx
    );
  const reference = { grant_id: row.id, changed_read_flags: changed };
  await service.db.insert(
    AD_EVENTS,
    {
      id: event.correlation_id,
      context_id: '00000000-0000-0000-0000-000000000000',
      actor_profile_id: event.coordinator_profile_id,
      kind: AUDIT_KIND,
      references_json: JSON.stringify({
        action: ACTION,
        correlation_id: event.correlation_id,
        program_id: PROGRAM_ID,
        ...reference
      }),
      created_at: Date.now()
    },
    ctx
  );
  return reference;
}

/** Closed IAM-only permission update; never creates grants or edits artwork. */
export async function setKeysAndGatesCoordinatorReadAccess(
  event: CoordinatorReadEvent,
  service: ArtworkDocumentationService
) {
  const { row, stored } = await existingCoordinatorGrant(
    event.coordinator_profile_id,
    service,
    {}
  );
  // Check the bounded program before writing; dry-run remains entirely read-only.
  const before = await projectionSummary(
    event.coordinator_profile_id,
    service,
    {}
  );
  const reference = event.apply
    ? await service.db.idempotent(
        digest([ACTION, event.correlation_id]),
        digest({
          action: ACTION,
          coordinator_profile_id: event.coordinator_profile_id
        }),
        {},
        (transaction) => applyReadAccess(event, service, transaction)
      )
    : {
        grant_id: row.id,
        changed_read_flags: COORDINATOR_READ_FLAGS.filter(
          (key) => stored[key] !== true
        )
      };
  const capabilities = await service.grantCapabilities(
    event.coordinator_profile_id,
    null,
    PROGRAM_ID,
    {}
  );
  return {
    correlation_id: event.correlation_id,
    mode: event.apply ? 'applied' : 'dry_run',
    program_id: PROGRAM_ID,
    coordinator_profile_id: event.coordinator_profile_id,
    ...reference,
    effective_capabilities: capabilities,
    target_capabilities: mergeCapabilities([
      parseJson<Partial<Capabilities>>(row.capabilities_json),
      Object.fromEntries(COORDINATOR_READ_FLAGS.map((key) => [key, true]))
    ]),
    ...(event.apply
      ? await projectionSummary(event.coordinator_profile_id, service, {})
      : before)
  };
}
