import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import {
  agentPatchSchema,
  CmsAgentPatchV1,
  CmsPackageV1,
  CmsValidationIssueV1,
  CmsValidationResultV1,
  validateCmsPackageV1
} from '@/profile-cms/protocol/v1';
import type { ZodIssue } from 'zod';

export const CMS_AGENT_PATCH_VALIDATION_RESULT_SCHEMA =
  '6529.cms.agent_patch_validation_result.v1' as const;

export interface ValidateProfileCmsAgentPatchRequest {
  readonly agent_patch: unknown;
  readonly apply?: boolean;
  readonly enforce_hashes?: boolean;
}

export interface ProfileCmsAgentPatchValidationResult {
  readonly schema: typeof CMS_AGENT_PATCH_VALIDATION_RESULT_SCHEMA;
  readonly valid: boolean;
  readonly applied: false;
  readonly checked_at: string;
  readonly target: {
    readonly draft_id: string;
    readonly package_id: string;
    readonly base_version: number;
    readonly base_package_hash: string;
    readonly agent_patch_id?: string;
  };
  readonly operation_count: number;
  readonly issues: CmsValidationIssueV1[];
  readonly candidate_validation?: CmsValidationResultV1;
}

export function validateProfileCmsAgentPatch({
  cmsPackage,
  packageDbId,
  packageId,
  version,
  packageHash,
  status,
  request,
  checkedAt
}: {
  readonly cmsPackage: CmsPackageV1;
  readonly packageDbId: string;
  readonly packageId: string;
  readonly version: number;
  readonly packageHash: string;
  readonly status: ProfileCmsPackageStatus;
  readonly request: ValidateProfileCmsAgentPatchRequest;
  readonly checkedAt?: Date | string;
}): ProfileCmsAgentPatchValidationResult {
  const checkedAtValue = formatCheckedAt(checkedAt);
  const parsedPatch = agentPatchSchema.safeParse(request.agent_patch);

  if (!parsedPatch.success) {
    return buildPatchValidationResult({
      checkedAt: checkedAtValue,
      packageDbId,
      packageId,
      version,
      packageHash,
      operationCount: 0,
      issues: parsedPatch.error.issues.map(mapZodIssue)
    });
  }

  const agentPatch = parsedPatch.data;
  const preflightIssues = validatePatchPreflight({
    agentPatch,
    packageDbId,
    version,
    packageHash,
    status,
    apply: request.apply
  });

  if (preflightIssues.length > 0) {
    return buildPatchValidationResult({
      checkedAt: checkedAtValue,
      packageDbId,
      packageId,
      version,
      packageHash,
      agentPatchId: agentPatch.patch_id,
      operationCount: agentPatch.operations.length,
      issues: preflightIssues
    });
  }

  const appliedPatch = dryRunApplyPatch(cmsPackage, agentPatch);
  const candidateValidation = validateCmsPackageV1(appliedPatch.candidate, {
    checkedAt: checkedAtValue,
    enforceHashes: request.enforce_hashes
  });
  const issues = [...appliedPatch.issues, ...candidateValidation.issues];

  return buildPatchValidationResult({
    checkedAt: checkedAtValue,
    packageDbId,
    packageId,
    version,
    packageHash,
    agentPatchId: agentPatch.patch_id,
    operationCount: agentPatch.operations.length,
    issues,
    candidateValidation
  });
}

function buildPatchValidationResult({
  checkedAt,
  packageDbId,
  packageId,
  version,
  packageHash,
  agentPatchId,
  operationCount,
  issues,
  candidateValidation
}: {
  readonly checkedAt: string;
  readonly packageDbId: string;
  readonly packageId: string;
  readonly version: number;
  readonly packageHash: string;
  readonly agentPatchId?: string;
  readonly operationCount: number;
  readonly issues: CmsValidationIssueV1[];
  readonly candidateValidation?: CmsValidationResultV1;
}): ProfileCmsAgentPatchValidationResult {
  return {
    schema: CMS_AGENT_PATCH_VALIDATION_RESULT_SCHEMA,
    valid: !issues.some((issue) => issue.severity === 'error'),
    applied: false,
    checked_at: checkedAt,
    target: {
      draft_id: packageDbId,
      package_id: packageId,
      base_version: version,
      base_package_hash: packageHash,
      ...(agentPatchId ? { agent_patch_id: agentPatchId } : {})
    },
    operation_count: operationCount,
    issues,
    ...(candidateValidation
      ? { candidate_validation: candidateValidation }
      : {})
  };
}

function validatePatchPreflight({
  agentPatch,
  packageDbId,
  version,
  packageHash,
  status,
  apply
}: {
  readonly agentPatch: CmsAgentPatchV1;
  readonly packageDbId: string;
  readonly version: number;
  readonly packageHash: string;
  readonly status: ProfileCmsPackageStatus;
  readonly apply: boolean | undefined;
}): CmsValidationIssueV1[] {
  const issues: CmsValidationIssueV1[] = [];

  if (apply === true) {
    issues.push(
      issue({
        code: 'agent_patch.apply_not_supported',
        message:
          'Patch validation is read-only; save and publish must use the CMS package endpoints.',
        path: '/apply'
      })
    );
  }

  if (status !== ProfileCmsPackageStatus.DRAFT) {
    issues.push(
      issue({
        code: 'agent_patch.target_not_draft',
        message: 'Agent patches can only be validated against draft packages.',
        path: '/agent_patch/target/draft_id'
      })
    );
  }

  if (agentPatch.target.draft_id !== packageDbId) {
    issues.push(
      issue({
        code: 'agent_patch.target_draft_mismatch',
        message: 'Patch target draft_id does not match the URL package id.',
        path: '/agent_patch/target/draft_id'
      })
    );
  }

  if (agentPatch.target.base_version !== version) {
    issues.push(
      issue({
        code: 'agent_patch.base_version_mismatch',
        message: 'Patch base_version does not match the draft version.',
        path: '/agent_patch/target/base_version'
      })
    );
  }

  if (agentPatch.target.base_package_hash !== packageHash) {
    issues.push(
      issue({
        code: 'agent_patch.base_package_hash_mismatch',
        message: 'Patch base_package_hash does not match the draft package.',
        path: '/agent_patch/target/base_package_hash'
      })
    );
  }

  return issues;
}

function dryRunApplyPatch(
  cmsPackage: CmsPackageV1,
  agentPatch: CmsAgentPatchV1
): {
  readonly candidate: unknown;
  readonly issues: CmsValidationIssueV1[];
} {
  const candidate = JSON.parse(JSON.stringify(cmsPackage)) as Record<
    string,
    unknown
  >;
  const issues: CmsValidationIssueV1[] = [];

  agentPatch.operations.forEach((operation, index) => {
    applyOperation(candidate, operation, index, issues);
  });

  return { candidate, issues };
}

function applyOperation(
  candidate: Record<string, unknown>,
  operation: CmsAgentPatchV1['operations'][number],
  index: number,
  issues: CmsValidationIssueV1[]
): void {
  const segments = parseJsonPointer(operation.path);
  if (!segments) {
    addPathIssue(index, issues, 'agent_patch.path_invalid', operation.path);
    return;
  }
  if (!isAllowedOperationPath(operation.op, segments)) {
    issues.push(
      issue({
        code: 'agent_patch.operation_path_not_allowed',
        message: `${operation.op} cannot target '${operation.path}'.`,
        path: `/operations/${index}/path`
      })
    );
    return;
  }

  switch (operation.op) {
    case 'add_page':
      insertAtArrayPath(
        candidate,
        operation.path,
        operation.value,
        index,
        issues
      );
      break;
    case 'remove_page':
    case 'remove_block':
      removeAtArrayPath(candidate, operation.path, index, issues);
      break;
    case 'update_page_metadata':
    case 'update_share_metadata':
    case 'update_block':
      mergeOrReplaceAtPath(
        candidate,
        operation.path,
        operation.value,
        index,
        issues
      );
      break;
    case 'add_block':
      insertAtArrayPath(
        candidate,
        operation.path,
        operation.value,
        index,
        issues
      );
      break;
    case 'reorder_blocks':
      reorderBlocks(candidate, operation.path, operation.value, index, issues);
      break;
    case 'update_navigation':
    case 'update_theme':
    case 'set_taxonomy_terms':
      replaceAtPath(candidate, operation.path, operation.value, index, issues);
      break;
    case 'attach_source_packet':
      attachSourcePacket(
        candidate,
        operation.path,
        operation.value,
        index,
        issues
      );
      break;
    default:
      assertNever(operation.op);
  }
}

function isAllowedOperationPath(
  operation: CmsAgentPatchV1['operations'][number]['op'],
  segments: string[]
): boolean {
  switch (operation) {
    case 'add_page':
    case 'remove_page':
      return isPayloadPagesElementPath(segments);
    case 'update_page_metadata':
    case 'update_share_metadata':
      return isPageMetadataPath(segments);
    case 'add_block':
    case 'update_block':
    case 'remove_block':
      return isBlockElementPath(segments);
    case 'reorder_blocks':
      return isBlocksArrayPath(segments);
    case 'update_navigation':
      return (
        segments.length === 2 &&
        segments[0] === 'payload' &&
        segments[1] === 'navigation'
      );
    case 'update_theme':
      return (
        segments.length === 2 &&
        segments[0] === 'site' &&
        segments[1] === 'theme'
      );
    case 'attach_source_packet':
      return isSourcePacketAppendPath(segments) || isPageSourcePath(segments);
    case 'set_taxonomy_terms':
      return isTaxonomyTermsPath(segments);
    default:
      assertNever(operation);
  }
}

function isPayloadPagesElementPath(segments: string[]): boolean {
  return (
    segments.length === 3 &&
    segments[0] === 'payload' &&
    segments[1] === 'pages'
  );
}

function isPageMetadataPath(segments: string[]): boolean {
  return (
    segments.length >= 4 &&
    segments[0] === 'payload' &&
    segments[1] === 'pages' &&
    segments[3] === 'metadata'
  );
}

function isBlocksArrayPath(segments: string[]): boolean {
  return (
    segments.length === 4 &&
    segments[0] === 'payload' &&
    segments[1] === 'pages' &&
    segments[3] === 'blocks'
  );
}

function isBlockElementPath(segments: string[]): boolean {
  return isBlocksArrayPath(segments.slice(0, 4)) && segments.length >= 5;
}

function isSourcePacketAppendPath(segments: string[]): boolean {
  return (
    segments.length === 3 &&
    segments[0] === 'payload' &&
    segments[1] === 'source_packets' &&
    segments[2] === '-'
  );
}

function isPageSourcePath(segments: string[]): boolean {
  return (
    segments.length >= 4 &&
    segments[0] === 'payload' &&
    segments[1] === 'pages' &&
    segments[3] === 'source'
  );
}

function isTaxonomyTermsPath(segments: string[]): boolean {
  return (
    segments.length === 4 &&
    segments[0] === 'payload' &&
    segments[1] === 'taxonomies' &&
    segments[3] === 'terms'
  );
}

function insertAtArrayPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  const resolved = resolveParent(root, path, operationIndex, issues);
  if (!resolved) {
    return;
  }
  if (!Array.isArray(resolved.parent)) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_not_array', path);
    return;
  }
  const index = getInsertIndex(resolved.parent, resolved.key);
  if (index === null) {
    addPathIssue(
      operationIndex,
      issues,
      'agent_patch.index_out_of_bounds',
      path
    );
    return;
  }
  resolved.parent.splice(index, 0, value);
}

function removeAtArrayPath(
  root: Record<string, unknown>,
  path: string,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  const resolved = resolveParent(root, path, operationIndex, issues);
  if (!resolved) {
    return;
  }
  if (!Array.isArray(resolved.parent)) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_not_array', path);
    return;
  }
  const index = getExistingArrayIndex(resolved.parent, resolved.key);
  if (index === null) {
    addPathIssue(
      operationIndex,
      issues,
      'agent_patch.index_out_of_bounds',
      path
    );
    return;
  }
  resolved.parent.splice(index, 1);
}

function mergeOrReplaceAtPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  const current = getAtPath(root, path, operationIndex, issues);
  if (!current.found) {
    return;
  }
  if (isRecord(current.value) && isRecord(value)) {
    replaceAtPath(
      root,
      path,
      { ...current.value, ...value },
      operationIndex,
      issues
    );
    return;
  }
  replaceAtPath(root, path, value, operationIndex, issues);
}

function replaceAtPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  const resolved = resolveParent(root, path, operationIndex, issues);
  if (!resolved) {
    return;
  }
  if (Array.isArray(resolved.parent)) {
    const index = getExistingArrayIndex(resolved.parent, resolved.key);
    if (index === null) {
      addPathIssue(
        operationIndex,
        issues,
        'agent_patch.index_out_of_bounds',
        path
      );
      return;
    }
    resolved.parent[index] = value;
    return;
  }
  resolved.parent[resolved.key] = value;
}

function reorderBlocks(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  const current = getAtPath(root, path, operationIndex, issues);
  if (!current.found) {
    return;
  }
  if (!Array.isArray(current.value)) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_not_array', path);
    return;
  }
  if (!isStringArray(value)) {
    issues.push(
      issue({
        code: 'agent_patch.reorder_value_invalid',
        message: 'reorder_blocks value must be an array of block ids.',
        path: `/operations/${operationIndex}/value`
      })
    );
    return;
  }
  const blocksById = new Map<string, unknown>();
  for (const block of current.value) {
    if (!isRecord(block) || typeof block.id !== 'string') {
      issues.push(
        issue({
          code: 'agent_patch.reorder_block_id_missing',
          message:
            'reorder_blocks requires every existing block to have an id.',
          path: `/operations/${operationIndex}/path`
        })
      );
      return;
    }
    if (blocksById.has(block.id)) {
      issues.push(
        issue({
          code: 'agent_patch.reorder_duplicate_block_id',
          message: `Block id '${block.id}' appears more than once.`,
          path: `/operations/${operationIndex}/path`
        })
      );
      return;
    }
    blocksById.set(block.id, block);
  }
  if (
    blocksById.size !== current.value.length ||
    blocksById.size !== value.length
  ) {
    addPathIssue(
      operationIndex,
      issues,
      'agent_patch.reorder_ids_mismatch',
      path
    );
    return;
  }
  const reordered: unknown[] = [];
  for (const blockId of value) {
    const block = blocksById.get(blockId);
    if (!block) {
      addPathIssue(
        operationIndex,
        issues,
        'agent_patch.reorder_ids_mismatch',
        path
      );
      return;
    }
    reordered.push(block);
  }
  replaceAtPath(root, path, reordered, operationIndex, issues);
}

function attachSourcePacket(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): void {
  if (path !== '/payload/source_packets/-') {
    replaceAtPath(root, path, value, operationIndex, issues);
    return;
  }
  const payload = getAtPath(root, '/payload', operationIndex, issues);
  if (!payload.found || !isRecord(payload.value)) {
    return;
  }
  const sourcePackets = payload.value.source_packets;
  if (sourcePackets === undefined) {
    payload.value.source_packets = [value];
    return;
  }
  if (!Array.isArray(sourcePackets)) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_not_array', path);
    return;
  }
  sourcePackets.push(value);
}

function resolveParent(
  root: Record<string, unknown>,
  path: string,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
): {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string;
} | null {
  const segments = parseJsonPointer(path);
  if (!segments || segments.length === 0) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_invalid', path);
    return null;
  }
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index++) {
    current = getChild(current, segments[index]);
    if (current === undefined) {
      addPathIssue(operationIndex, issues, 'agent_patch.path_missing', path);
      return null;
    }
  }
  if (!isRecord(current) && !Array.isArray(current)) {
    addPathIssue(
      operationIndex,
      issues,
      'agent_patch.path_not_container',
      path
    );
    return null;
  }
  return {
    parent: current,
    key: segments[segments.length - 1]
  };
}

function getAtPath(
  root: Record<string, unknown>,
  path: string,
  operationIndex: number,
  issues: CmsValidationIssueV1[]
):
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false } {
  const segments = parseJsonPointer(path);
  if (!segments) {
    addPathIssue(operationIndex, issues, 'agent_patch.path_invalid', path);
    return { found: false };
  }
  let current: unknown = root;
  for (const segment of segments) {
    current = getChild(current, segment);
    if (current === undefined) {
      addPathIssue(operationIndex, issues, 'agent_patch.path_missing', path);
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function getChild(container: unknown, key: string): unknown {
  if (Array.isArray(container)) {
    const index = getExistingArrayIndex(container, key);
    return index === null ? undefined : container[index];
  }
  if (isRecord(container)) {
    return container[key];
  }
  return undefined;
}

function parseJsonPointer(path: string): string[] | null {
  if (!path.startsWith('/')) {
    return null;
  }
  const segments = path
    .slice(1)
    .split('/')
    .map((segment) => segment.split('~1').join('/').split('~0').join('~'));
  if (segments.some(isUnsafePathSegment)) {
    return null;
  }
  return segments;
}

function isUnsafePathSegment(segment: string): boolean {
  return (
    segment === '__proto__' ||
    segment === 'prototype' ||
    segment === 'constructor'
  );
}

function getExistingArrayIndex(array: unknown[], key: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) {
    return null;
  }
  const index = Number(key);
  return index >= 0 && index < array.length ? index : null;
}

function getInsertIndex(array: unknown[], key: string): number | null {
  if (key === '-') {
    return array.length;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(key)) {
    return null;
  }
  const index = Number(key);
  return index >= 0 && index <= array.length ? index : null;
}

function addPathIssue(
  operationIndex: number,
  issues: CmsValidationIssueV1[],
  code: string,
  path: string
): void {
  issues.push(
    issue({
      code,
      message: `Patch operation path '${path}' cannot be applied safely.`,
      path: `/operations/${operationIndex}/path`
    })
  );
}

function mapZodIssue(zodIssue: ZodIssue): CmsValidationIssueV1 {
  return issue({
    code: 'agent_patch.schema_invalid',
    message: zodIssue.message,
    path: toJsonPointer(zodIssue.path)
  });
}

function issue(input: {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}): CmsValidationIssueV1 {
  return {
    severity: 'error',
    code: input.code,
    message: input.message,
    path: input.path
  };
}

function toJsonPointer(path: ZodIssue['path']): string {
  if (!path.length) {
    return '/';
  }
  return `/${path.map((segment) => String(segment)).join('/')}`;
}

function formatCheckedAt(value: Date | string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported CMS agent patch operation: ${value}`);
}
