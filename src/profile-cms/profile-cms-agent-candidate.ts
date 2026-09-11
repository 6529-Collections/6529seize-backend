import { CustomApiCompliantException } from '@/exceptions';
import {
  canonicalizeJson,
  CmsPackageV1,
  cmsPackageSchema,
  validateCmsPackageV1,
  withComputedCmsHashes
} from '@/profile-cms/protocol/v1';

export const CMS_AGENT_MAX_BYTES = 1024 * 1024;
export const CMS_AGENT_MAX_DEPTH = 32;
export const CMS_AGENT_MAX_NODES = 50000;

export function assertCmsAgentJsonBounded(input: unknown): void {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 }
  ];
  let nodes = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++nodes > CMS_AGENT_MAX_NODES || item.depth > CMS_AGENT_MAX_DEPTH)
      oversized();
    if (!item.value || typeof item.value !== 'object') continue;
    for (const [key, value] of Object.entries(item.value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new CustomApiCompliantException(
          400,
          'Unsupported candidate property',
          'cms_agent_invalid_candidate'
        );
      }
      queue.push({ value, depth: item.depth + 1 });
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > CMS_AGENT_MAX_BYTES
  )
    oversized();
}

function oversized(): never {
  throw new CustomApiCompliantException(
    413,
    'CMS agent request exceeds its size or complexity limit',
    'cms_agent_request_too_large'
  );
}

export function validateCmsAgentCandidate(
  base: CmsPackageV1,
  input: unknown,
  now: number
) {
  assertCmsAgentJsonBounded(input);
  const parsed = cmsPackageSchema.safeParse(input);
  if (!parsed.success) {
    throw new CustomApiCompliantException(
      400,
      'Candidate must be a complete CMS V1 package',
      'cms_agent_invalid_candidate'
    );
  }
  const candidate = parsed.data;
  if (
    candidate.package_id !== base.package_id ||
    canonicalizeJson(candidate.profile) !== canonicalizeJson(base.profile) ||
    candidate.site.base_path !== base.site.base_path
  ) {
    throw new CustomApiCompliantException(
      400,
      'Candidate cannot change the draft identity or root path',
      'cms_agent_identity_changed'
    );
  }
  if (
    canonicalizeJson(candidate.payload.assets) !==
    canonicalizeJson(base.payload.assets)
  ) {
    throw new CustomApiCompliantException(
      400,
      'Use the existing draft assets; the owner adds new media',
      'cms_agent_assets_changed'
    );
  }
  const normalized = withComputedCmsHashes(candidate);
  const at = new Date(now).toISOString();
  normalized.signatures = [
    { type: 'fixture', signer: 'fixture', signature: 'fixture', signed_at: at }
  ];
  normalized.storage = [
    {
      provider: 'fixture',
      uri: 'https://6529.io/profile-cms/draft',
      content_hash: normalized.integrity.package_hash,
      canonical: false,
      recorded_at: at
    }
  ];
  const validation = validateCmsPackageV1(normalized, {
    checkedAt: at,
    allowFixtureSignatures: true,
    allowFixtureStorage: true,
    enforceHashes: true
  });
  return {
    valid: validation.valid,
    validation,
    candidate_package: normalized,
    candidate_package_hash: normalized.integrity.package_hash
  };
}
