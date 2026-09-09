import { randomUUID } from 'crypto';
import { RequestContext } from '@/request.context';
import { artworkAssetsService } from './assets/artwork-assets.service';
import {
  ARTWORK_ASSET_ROLES,
  ArtworkAssetRole,
  AssetAccess
} from './assets/artwork-assets.types';
import { artworkDocumentationService as core } from './artwork-documentation.service';
import {
  AssetLink,
  ContextAccess,
  Mutation
} from './artwork-documentation.types';
import { requireEdit } from './artwork-documentation.access';
import { fail } from './artwork-documentation.validation';

export function toAssetAccess(access: ContextAccess): AssetAccess {
  return {
    actorProfileId: access.actorProfileId,
    canEdit:
      access.context.lifecycle === 'active' &&
      access.capabilities.edit_modules.includes('files'),
    canReadArchivalFiles: access.capabilities.read_archival_files,
    canReadRightsEvidence: access.capabilities.read_rights_evidence,
    canReadRestricted: access.isArtist
  };
}
core.setAssetGateway({
  listAssets: async (contextId, access) =>
    artworkAssetsService.listAssets(contextId, toAssetAccess(access)),
  validateReadyAsset: async (contextId, assetId, access, ctx) => ({
    ...(await artworkAssetsService.validateReadyAsset(
      contextId,
      assetId,
      toAssetAccess(access),
      ctx.connection
    ))
  }),
  markReferenced: async (contextId, assetIds, ctx) => {
    if (!ctx.connection) fail(500, 'TRANSACTION_REQUIRED');
    await artworkAssetsService.markReferenced(
      contextId,
      assetIds,
      ctx.connection
    );
  }
});

export type AssetLinkInput = Omit<AssetLink, 'id' | 'manifest'>;
function normalizeLink(raw: AssetLinkInput): AssetLinkInput {
  if (!ARTWORK_ASSET_ROLES.includes(raw.role as ArtworkAssetRole))
    fail(422, 'INVALID_ASSET_ROLE');
  if (
    ['rights_instrument', 'consent_instrument'].includes(raw.role) &&
    raw.intended_visibility !== 'restricted'
  )
    fail(422, 'RESTRICTED_VISIBILITY_REQUIRED');
  if (
    ['proposed_license', 'already_licensed'].includes(
      raw.intended_terms.kind
    ) &&
    !raw.intended_terms.license_uri
  )
    fail(422, 'LICENSE_URI_REQUIRED');
  return {
    asset_id: raw.asset_id,
    role: raw.role,
    intended_visibility: raw.intended_visibility,
    intended_terms: raw.intended_terms,
    label: raw.label ?? '',
    description: raw.description ?? '',
    source_of_asset: raw.source_of_asset ?? 'unknown',
    source_credit: raw.source_credit ?? '',
    derived_from_asset_ids: raw.derived_from_asset_ids ?? [],
    deposit_note: raw.deposit_note ?? ''
  };
}
export function validateDerivations(links: AssetLink[]): void {
  const graph = new Map<string, string[]>();
  for (const link of links)
    graph.set(link.asset_id, [
      ...(graph.get(link.asset_id) ?? []),
      ...link.derived_from_asset_ids
    ]);
  const completed = new Set<string>();
  const walk = (id: string, path: Set<string>): void => {
    if (path.has(id)) fail(422, 'CYCLIC_ASSET_DERIVATION');
    if (completed.has(id)) return;
    const next = new Set(path);
    next.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!graph.has(dependency)) fail(422, 'DERIVATION_ASSET_NOT_LINKED');
      walk(dependency, next);
    }
    completed.add(id);
  };
  for (const id of Array.from(graph.keys())) walk(id, new Set());
}
export async function writeAssetLink(
  id: string,
  raw: AssetLinkInput,
  mutation: Mutation,
  ctx: RequestContext,
  linkId?: string
) {
  await core.mutate(id, mutation, ctx, async (access, transaction) => {
    requireEdit(access, 'files');
    const input = normalizeLink(raw);
    const old = linkId
      ? access.context.asset_links.find((link) => link.id === linkId)
      : null;
    if (linkId && (!old || !core.canReadAssetLink(old, access)))
      fail(404, 'UNAVAILABLE');
    if (old && old.asset_id !== input.asset_id)
      fail(422, 'ASSET_LINK_BYTES_IMMUTABLE');
    if (
      access.context.asset_links.some(
        (link) =>
          link.asset_id === input.asset_id &&
          link.role === input.role &&
          link.id !== linkId
      )
    )
      fail(409, 'ASSET_ROLE_ALREADY_LINKED');
    if (!old && access.context.asset_links.length >= 100)
      fail(413, 'ASSET_LINK_LIMIT');
    const assetAccess = toAssetAccess(access);
    await artworkAssetsService.validateReadyAsset(
      id,
      input.asset_id,
      assetAccess,
      transaction.connection
    );
    if (!transaction.connection) fail(500, 'TRANSACTION_REQUIRED');
    const rightsEvidence =
      ['rights_instrument', 'consent_instrument'].includes(input.role) ||
      access.context.restricted_paths.includes(
        `asset-rights:${input.asset_id}`
      );
    const restricted =
      rightsEvidence ||
      input.intended_visibility === 'restricted' ||
      access.context.restricted_paths.includes(`asset:${input.asset_id}`) ||
      access.context.asset_links.some(
        (item) =>
          item.asset_id === input.asset_id &&
          item.intended_visibility === 'restricted'
      );
    const effectiveVisibility = restricted ? 'restricted' : 'public_record';
    await artworkAssetsService.updateDisclosure(
      id,
      input.asset_id,
      assetAccess,
      {
        intended_visibility: effectiveVisibility,
        role: input.role as ArtworkAssetRole
      },
      transaction.connection
    );
    const manifest = await artworkAssetsService.validateReadyAsset(
      id,
      input.asset_id,
      assetAccess,
      transaction.connection
    );
    const link: AssetLink = {
      ...input,
      id: old?.id ?? randomUUID(),
      manifest: { ...manifest }
    };
    access.context.asset_links = old
      ? access.context.asset_links.map((item) =>
          item.id === old.id ? link : item
        )
      : [...access.context.asset_links, link];
    if (restricted)
      access.context.restricted_paths = Array.from(
        new Set([
          ...access.context.restricted_paths,
          `asset:${link.asset_id}`,
          ...(rightsEvidence ? [`asset-rights:${link.asset_id}`] : [])
        ])
      );
    validateDerivations(access.context.asset_links);
    await artworkAssetsService.markReferenced(
      id,
      [link.asset_id],
      transaction.connection
    );
    return { context_id: id };
  });
  return core.getContext(id, ctx);
}
export async function removeAssetLink(
  id: string,
  linkId: string,
  mutation: Mutation,
  ctx: RequestContext
) {
  await core.mutate(id, mutation, ctx, async (access, transaction) => {
    requireEdit(access, 'files');
    const link = access.context.asset_links.find((item) => item.id === linkId);
    if (!link || !core.canReadAssetLink(link, access)) fail(404, 'UNAVAILABLE');
    access.context.asset_links = access.context.asset_links.filter(
      (item) => item.id !== linkId
    );
    validateDerivations(access.context.asset_links);
    await core.validateAssetReferences(access, transaction, false);
    return { context_id: id };
  });
  return core.getContext(id, ctx);
}
