import { randomUUID } from 'node:crypto';
import { PROFILES_TABLE, USER_GROUPS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import {
  AD_CONTEXTS,
  AD_EVENTS,
  AD_GRANTS,
  AD_PROGRAM_VIEWERS
} from './artwork-documentation.tables';
import {
  ProgramViewerRow,
  ProgramViewerSubject,
  programViewerCapabilities
} from './artwork-documentation.program-viewers';
import { parseJson } from './artwork-documentation.db';
import { digest, fail } from './artwork-documentation.validation';
import { PROFILES } from './artwork-documentation.catalogue';

const ACTION = 'set_program_viewers_v1';
const AUDIT_KIND = 'operator_program_viewers';
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export type ProgramViewersEvent = {
  operator_action: typeof ACTION;
  correlation_id: string;
  coordinator_profile_id: string;
  program_id: string;
  viewers: { profiles: string[]; groups: string[] };
  expected_inventory_sha256?: string;
  apply: boolean;
};
type ProgramGrant = {
  id: string;
  subject_profile_id: string;
  capabilities_json: unknown;
  revoked_at: number | null;
};

function subjectIds(value: unknown, isProfile: boolean): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !(isProfile ? uuid : /^[\w-]{1,200}$/).test(id)
    )
  )
    fail(422, 'INVALID_OPERATOR_REQUEST');
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) fail(422, 'INVALID_OPERATOR_REQUEST');
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function parseProgramViewersEvent(
  input: Record<string, unknown>
): ProgramViewersEvent {
  const allowed = new Set([
    'operator_action',
    'correlation_id',
    'coordinator_profile_id',
    'program_id',
    'viewers',
    'expected_inventory_sha256',
    'apply'
  ]);
  const viewers = input.viewers as Record<string, unknown> | undefined;
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    typeof input.coordinator_profile_id !== 'string' ||
    !uuid.test(input.coordinator_profile_id) ||
    typeof input.program_id !== 'string' ||
    !PROFILES.some((profile) => profile.program_id === input.program_id) ||
    !viewers ||
    typeof viewers !== 'object' ||
    Array.isArray(viewers) ||
    Object.keys(viewers).some((key) => !['profiles', 'groups'].includes(key)) ||
    (input.apply !== undefined && typeof input.apply !== 'boolean') ||
    (input.expected_inventory_sha256 !== undefined &&
      (typeof input.expected_inventory_sha256 !== 'string' ||
        !/^[a-f\d]{64}$/.test(input.expected_inventory_sha256))) ||
    (input.apply === true && input.expected_inventory_sha256 === undefined)
  )
    fail(422, 'INVALID_OPERATOR_REQUEST');
  return {
    operator_action: ACTION,
    correlation_id: input.correlation_id as string,
    coordinator_profile_id: input.coordinator_profile_id,
    program_id: input.program_id,
    viewers: {
      profiles: subjectIds(viewers.profiles, true),
      groups: subjectIds(viewers.groups, false)
    },
    ...(input.expected_inventory_sha256 === undefined
      ? {}
      : {
          expected_inventory_sha256: input.expected_inventory_sha256 as string
        }),
    apply: input.apply === true
  };
}

async function inventory(
  event: ProgramViewersEvent,
  service: ArtworkDocumentationService,
  ctx: RequestContext,
  lock = false
) {
  const programGrants = await service.db.query<ProgramGrant>(
    `SELECT id,subject_profile_id,capabilities_json,revoked_at FROM ${AD_GRANTS} WHERE program_id=:program AND context_id IS NULL ORDER BY id LIMIT 1001${lock ? ' FOR UPDATE' : ''}`,
    { program: event.program_id },
    ctx
  );
  const viewers = await service.db.query<ProgramViewerRow>(
    `SELECT * FROM ${AD_PROGRAM_VIEWERS} WHERE program_id=:program ORDER BY id LIMIT 1001${lock ? ' FOR UPDATE' : ''}`,
    { program: event.program_id },
    ctx
  );
  if (programGrants.length > 1000 || viewers.length > 1000)
    fail(409, 'PROGRAM_ACCESS_LIMIT');
  const coordinator = programGrants.some((row) => {
    const caps = parseJson<Record<string, unknown>>(row.capabilities_json);
    return (
      row.subject_profile_id === event.coordinator_profile_id &&
      row.revoked_at === null &&
      caps.read_context === true &&
      caps.manage_context === true &&
      caps.manage_assignments === true
    );
  });
  if (!coordinator) fail(403, 'EXISTING_COORDINATOR_GRANT_REQUIRED');
  const state = {
    program_grants: programGrants.map(({ capabilities_json, ...row }) => ({
      ...row,
      capabilities: parseJson(capabilities_json)
    })),
    viewers
  };
  return { ...state, inventory_sha256: digest(state) };
}

async function validateSubjects(
  event: ProgramViewersEvent,
  service: ArtworkDocumentationService,
  ctx: RequestContext
) {
  const profiles = Array.from(
    new Set([event.coordinator_profile_id, ...event.viewers.profiles])
  );
  const found = await service.db.query<{ external_id: string }>(
    `SELECT external_id FROM ${PROFILES_TABLE} WHERE external_id IN (:profiles)`,
    { profiles },
    ctx
  );
  if (found.length !== profiles.length) fail(422, 'VIEWER_PROFILE_NOT_FOUND');
  if (event.viewers.groups.length) {
    const groups = await service.db.query<{ id: string }>(
      `SELECT id FROM ${USER_GROUPS_TABLE} WHERE id IN (:groups) AND visible=true`,
      { groups: event.viewers.groups },
      ctx
    );
    if (groups.length !== event.viewers.groups.length)
      fail(422, 'VIEWER_GROUP_NOT_FOUND');
  }
}

function desiredSubjects(event: ProgramViewersEvent): ProgramViewerSubject[] {
  return [
    ...event.viewers.profiles.map((subject_id) => ({
      subject_type: 'profile' as const,
      subject_id
    })),
    ...event.viewers.groups.map((subject_id) => ({
      subject_type: 'group' as const,
      subject_id
    }))
  ];
}
function sameSubject(a: ProgramViewerSubject, b: ProgramViewerSubject) {
  return a.subject_type === b.subject_type && a.subject_id === b.subject_id;
}

async function replaceViewers(
  event: ProgramViewersEvent,
  before: ProgramViewerRow[],
  service: ArtworkDocumentationService,
  ctx: RequestContext
) {
  const desired = desiredSubjects(event);
  const now = Date.now();
  for (const row of before) {
    const retained = desired.some((subject) => sameSubject(subject, row));
    if (retained === (row.revoked_at === null)) continue;
    await service.db.query(
      `UPDATE ${AD_PROGRAM_VIEWERS} SET revoked_at=:revoked,grantor_profile_id=:grantor WHERE id=:id`,
      {
        id: row.id,
        revoked: retained ? null : now,
        grantor: event.coordinator_profile_id
      },
      ctx
    );
  }
  for (const subject of desired) {
    if (before.some((row) => sameSubject(row, subject))) continue;
    await service.db.insert(
      AD_PROGRAM_VIEWERS,
      {
        id: randomUUID(),
        program_id: event.program_id,
        ...subject,
        grantor_profile_id: event.coordinator_profile_id,
        created_at: now,
        revoked_at: null
      },
      ctx
    );
  }
}

async function replay(
  event: ProgramViewersEvent,
  requestHash: string,
  service: ArtworkDocumentationService,
  ctx: RequestContext
) {
  const row = await service.db.one<{
    kind: string;
    actor_profile_id: string;
    references_json: unknown;
  }>(
    `SELECT kind,actor_profile_id,references_json FROM ${AD_EVENTS} WHERE id=:id`,
    { id: event.correlation_id },
    ctx
  );
  if (!row) return null;
  const reference = parseJson<{
    request_hash: string;
    response: Record<string, unknown>;
  }>(row.references_json);
  if (
    row.kind !== AUDIT_KIND ||
    row.actor_profile_id !== event.coordinator_profile_id ||
    reference.request_hash !== requestHash
  )
    fail(409, 'IDEMPOTENCY_MISMATCH');
  return reference.response;
}

/** IAM-only replacement of viewer configuration; existing grants and artist records are untouched. */
export async function setProgramViewers(
  event: ProgramViewersEvent,
  service: ArtworkDocumentationService
) {
  const requestHash = digest({ ...event, apply: true });
  if (event.apply) {
    const previous = await replay(event, requestHash, service, {});
    if (previous) return previous;
  }
  await validateSubjects(event, service, {});
  const before = await inventory(event, service, {});
  const count = await service.db.one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${AD_CONTEXTS} WHERE program_id=:program`,
    { program: event.program_id },
    {}
  );
  const base = {
    correlation_id: event.correlation_id,
    program_id: event.program_id,
    coordinator_profile_id: event.coordinator_profile_id,
    desired_viewers: desiredSubjects(event),
    viewer_capabilities: programViewerCapabilities(),
    contexts_count: Number(count?.count ?? 0)
  };
  if (!event.apply) return { ...base, mode: 'dry_run', inventory: before };
  return service.db.idempotent(
    digest([ACTION, event.correlation_id]),
    requestHash,
    {},
    async (ctx) => {
      // Lock the existing program grants before viewer rows to serialize roster updates.
      const current = await inventory(event, service, ctx, true);
      const previous = await replay(event, requestHash, service, ctx);
      if (previous) return previous;
      if (current.inventory_sha256 !== event.expected_inventory_sha256)
        fail(409, 'PROGRAM_ACCESS_CHANGED');
      await validateSubjects(event, service, ctx);
      await replaceViewers(event, current.viewers, service, ctx);
      const after = await inventory(event, service, ctx);
      const profileVerification = [];
      for (const profileId of event.viewers.profiles) {
        profileVerification.push({
          profile_id: profileId,
          effective_capabilities: await service.grantCapabilities(
            profileId,
            null,
            event.program_id,
            ctx
          )
        });
      }
      const response = {
        ...base,
        mode: 'applied',
        before_inventory: current,
        inventory: after,
        profile_verification: profileVerification
      };
      await service.db.insert(
        AD_EVENTS,
        {
          id: event.correlation_id,
          context_id: '00000000-0000-0000-0000-000000000000',
          actor_profile_id: event.coordinator_profile_id,
          kind: AUDIT_KIND,
          references_json: JSON.stringify({
            action: ACTION,
            request_hash: requestHash,
            response
          }),
          created_at: Date.now()
        },
        ctx
      );
      return response;
    }
  );
}
