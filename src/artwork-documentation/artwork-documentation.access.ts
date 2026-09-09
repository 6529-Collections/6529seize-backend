import {
  Capabilities,
  ContextAccess,
  ModuleId,
  MODULE_IDS,
  ReviewLane,
  REVIEW_LANES
} from './artwork-documentation.types';
import { LOCKED_RESTRICTED } from './artwork-documentation.catalogue';
import { fail } from './artwork-documentation.validation';

export function emptyCapabilities(): Capabilities {
  return {
    read_context: false,
    edit_modules: [],
    read_archival_files: false,
    read_rights_evidence: false,
    read_source_receipts: false,
    read_contact: false,
    confirm_as_artist: false,
    review_lanes: [],
    manage_assignments: false,
    manage_context: false
  };
}
export function artistCapabilities(): Capabilities {
  return {
    read_context: true,
    edit_modules: [...MODULE_IDS],
    read_archival_files: true,
    read_rights_evidence: true,
    read_source_receipts: true,
    read_contact: true,
    confirm_as_artist: true,
    review_lanes: [],
    manage_assignments: true,
    manage_context: true
  };
}
export function mergeCapabilities(
  grants: Partial<Capabilities>[]
): Capabilities {
  const result = emptyCapabilities();
  for (const grant of grants)
    for (const key of Object.keys(result) as (keyof Capabilities)[]) {
      if (key === 'confirm_as_artist') continue;
      if (key === 'edit_modules')
        result.edit_modules = Array.from(
          new Set([
            ...result.edit_modules,
            ...(grant.edit_modules ?? []).filter((id) =>
              MODULE_IDS.includes(id)
            )
          ])
        );
      else if (key === 'review_lanes')
        result.review_lanes = Array.from(
          new Set([
            ...result.review_lanes,
            ...(grant.review_lanes ?? []).filter((id) =>
              REVIEW_LANES.includes(id)
            )
          ])
        );
      else result[key] = result[key] || grant[key] === true;
    }
  return result;
}
export function canReadField(
  access: ContextAccess,
  path: string,
  restricted = false
): boolean {
  if (access.isArtist) return true;
  if (path === 'identity.private_contact')
    return access.capabilities.read_contact;
  if (LOCKED_RESTRICTED.includes(path))
    return access.capabilities.read_rights_evidence;
  const effectiveRestricted =
    restricted || access.context.restricted_paths.includes(path);
  if (!effectiveRestricted) return true;
  if (path.startsWith('rights.'))
    return access.capabilities.read_rights_evidence;
  if (
    path.startsWith('files.') ||
    path.startsWith('preservation.') ||
    path.startsWith('process.')
  )
    return access.capabilities.read_archival_files;
  return false;
}
export function validateGrant(
  raw: unknown,
  access: ContextAccess
): Capabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail(422, 'INVALID_GRANT');
  const value = raw as Record<string, unknown>;
  const allowed = Object.keys(emptyCapabilities());
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) fail(422, 'INVALID_GRANT');
    if (key === 'edit_modules' || key === 'review_lanes') {
      const valid = key === 'edit_modules' ? MODULE_IDS : REVIEW_LANES;
      if (
        !Array.isArray(item) ||
        item.some((id) => !(valid as readonly unknown[]).includes(id))
      )
        fail(422, 'INVALID_GRANT');
    } else if (typeof item !== 'boolean') fail(422, 'INVALID_GRANT');
  }
  if (value.confirm_as_artist === true)
    fail(403, 'ARTIST_AUTHORITY_NOT_GRANTABLE');
  const grant = mergeCapabilities([value as Partial<Capabilities>]);
  // Artist editor grants cannot appoint institutional reviewers or coordinators.
  if (
    access.isArtist &&
    (grant.review_lanes.length ||
      grant.manage_assignments ||
      grant.manage_context)
  )
    fail(403, 'REVIEWER_ASSIGNMENT_REQUIRED');
  for (const key of [
    'read_archival_files',
    'read_rights_evidence',
    'read_source_receipts',
    'read_contact'
  ] as const)
    if (grant[key] && !access.capabilities[key]) {
      const assignedEvidence =
        !access.isArtist &&
        access.capabilities.manage_assignments &&
        ((key === 'read_rights_evidence' &&
          grant.review_lanes.includes('rights')) ||
          (key === 'read_archival_files' &&
            grant.review_lanes.includes('technical')) ||
          (key === 'read_source_receipts' &&
            grant.review_lanes.includes('curatorial')));
      if (!assignedEvidence) fail(403, 'CANNOT_ELEVATE_GRANT');
    }
  if (!access.isArtist && grant.edit_modules.length)
    fail(403, 'ARTIST_EDITOR_GRANT_REQUIRED');
  if (grant.manage_assignments || grant.manage_context)
    fail(403, 'PROGRAM_ADMIN_REQUIRED');
  grant.read_context = true;
  return grant;
}
export function laneForModule(moduleId: string): ReviewLane {
  return moduleId === 'rights'
    ? 'rights'
    : ['files', 'process', 'preservation'].includes(moduleId)
      ? 'technical'
      : 'curatorial';
}
export function requireEdit(access: ContextAccess, moduleId: ModuleId): void {
  if (!access.capabilities.edit_modules.includes(moduleId))
    fail(403, 'EDIT_NOT_ALLOWED');
  if (access.context.lifecycle !== 'active') fail(409, 'CONTEXT_ARCHIVED');
}
