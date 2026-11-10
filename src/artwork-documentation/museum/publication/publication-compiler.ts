import { parseJson } from '../../artwork-documentation.db';
import { ContextRecord } from '../../artwork-documentation.types';
import { answerValue, digest } from '../../artwork-documentation.validation';
import {
  AssetTechnicalMetadata,
  StoredAsset
} from '../../assets/artwork-assets.types';
import { dossierSourceHash } from '../export/dossier';
import { DossierSnapshot } from '../export/dossier.types';
import { buildIiif } from '../export/iiif';
import { IiifResource, mediaFacts } from '../export/iiif-resources';
import {
  draftAssetId,
  rebaseManifest,
  resolveBindings,
  ResolvedBindings
} from './publication-bindings';
import { canonicalRightsUri, iiifRightsUri } from './publication-rights';
import { validatePublicationManifest } from './publication-validation';
import {
  CompiledPublication,
  PUBLICATION_COMPILER_VERSION,
  PublicationInput,
  PublicationRights,
  reject,
  RESOURCE_ROLE_LABELS,
  RESOURCE_ROLES,
  ResourceRole
} from './publication.types';

export const IIIF_CONTEXT = 'http://iiif.io/api/presentation/3/context.json'; // NOSONAR: canonical IIIF namespace identifier, never fetched.
/** Media profiles whose complete work is a running program rather than fixed bytes. */
const LIVE_MEDIA_PROFILES = ['generative', 'interactive', 'html'];
const SOURCE_HASH = /^[a-f0-9]{64}$/;

const draftPrefix = (context: ContextRecord) =>
  `https://example.invalid/publication-draft/${context.id}`;
const en = (text: string) => ({ en: [text] });
const entry = (label: string, value: string) => ({
  label: en(label),
  value: en(value)
});

function resolveSelection(
  snapshot: DossierSnapshot,
  selection: PublicationInput['selection']
): StoredAsset[] {
  const ids = selection?.asset_ids;
  if (!Array.isArray(ids) || !ids.length)
    reject('EMPTY_SELECTION', 'Select at least one approved public asset.');
  if (new Set(ids).size !== ids.length)
    reject('DUPLICATE_SELECTION', 'The selection repeats an asset id.');
  const links = new Map(
    snapshot.context.asset_links.map((link) => [link.asset_id, link])
  );
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  for (const id of ids) {
    const asset = typeof id === 'string' ? assets.get(id) : undefined;
    if (!asset)
      reject(
        'UNKNOWN_ASSET',
        'The selection names a file not in the dossier.',
        String(id)
      );
    const link = links.get(asset.id);
    if (
      asset.intended_visibility !== 'public_record' ||
      !link ||
      link.intended_visibility !== 'public_record'
    )
      reject(
        'PRIVATE_ASSET',
        'Only files intended for the public record can be published.',
        asset.id
      );
    if (asset.access_class === 'rights_evidence')
      reject(
        'RIGHTS_EVIDENCE_ASSET',
        'Rights evidence is never published in a presentation manifest.',
        asset.id
      );
  }
  // Snapshot order, not selection order, so permuted selections compile identically.
  const chosen = new Set(ids);
  return snapshot.assets.filter((asset) => chosen.has(asset.id));
}

export function isLiveWork(context: ContextRecord): boolean {
  const profiles = answerValue<string[]>(
    context.modules.artwork.media_profiles
  );
  return (
    Array.isArray(profiles) &&
    profiles.some((profile) => LIVE_MEDIA_PROFILES.includes(profile))
  );
}

function resolveRoles(
  context: ContextRecord,
  selected: StoredAsset[],
  roles: PublicationInput['roles']
): Map<string, ResourceRole> {
  const supplied = roles && typeof roles === 'object' ? roles : {};
  const selectedIds = new Set(selected.map((asset) => asset.id));
  for (const id of Object.keys(supplied))
    if (!selectedIds.has(id))
      reject(
        'ROLE_NOT_SELECTED',
        'A role names an asset that is not in the approved selection.',
        id
      );
  const live = isLiveWork(context);
  const result = new Map<string, ResourceRole>();
  for (const asset of selected) {
    const role = supplied[asset.id];
    if (role === undefined)
      reject(
        'MISSING_ROLE',
        'Every selected asset needs a resource role.',
        asset.id
      );
    if (!RESOURCE_ROLES.includes(role))
      reject('UNSUPPORTED_ROLE', 'Unknown resource role.', asset.id);
    if (role === 'live_upstream_service')
      reject(
        'INCONSISTENT_ROLE',
        'A stored file is not a live service; the live realization is linked from the context answers instead.',
        asset.id
      );
    if (
      live &&
      role === 'authorized_manifestation' &&
      mediaFacts(asset).type === 'Image'
    )
      reject(
        'INCONSISTENT_ROLE',
        'A still of a generative or live work records one viewing; publish it as a documentation surrogate.',
        asset.id
      );
    result.set(asset.id, role);
  }
  return result;
}

function resolveRights(rights: PublicationRights) {
  const canonical = canonicalRightsUri(rights?.rights_uri);
  if (!canonical)
    reject(
      'RIGHTS_URI_NOT_IN_REGISTRY',
      'The rights URI must be a canonical URI from the museum rights registry.'
    );
  const statement = rights.required_statement;
  const text = (value: unknown) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 1000;
  if (!statement || !text(statement.label) || !text(statement.value))
    reject(
      'ATTRIBUTION_REQUIRED',
      'A required attribution statement with a label and value is mandatory.'
    );
  if (rights.provider !== undefined) {
    const provider = rights.provider;
    let valid =
      provider !== null && typeof provider === 'object' && text(provider.label);
    try {
      const url = new URL(String(provider?.id));
      valid =
        valid && url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      valid = false;
    }
    if (!valid)
      reject('INVALID_PROVIDER', 'A provider needs an https id and a label.');
  }
  return {
    canonical,
    iiif: iiifRightsUri(canonical),
    statement,
    provider: rights.provider
  };
}

function captureDate(asset: StoredAsset): string | undefined {
  const metadata = asset.technical_metadata_json
    ? parseJson<AssetTechnicalMetadata>(asset.technical_metadata_json)
    : null;
  for (const key of ['capture_date', 'date_time_original']) {
    const value = metadata?.properties?.[key];
    if (typeof value === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?/.test(value))
      return value;
  }
  return undefined;
}

/** `context.sources` entries of kind `artwork` with an https URL describe the live upstream realization. */
export function liveUpstreamUrls(context: ContextRecord): string[] {
  const sources =
    answerValue<{ kind?: unknown; url?: unknown }[]>(
      context.modules.context.sources
    ) ?? [];
  const result: string[] = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.kind !== 'artwork' || typeof source.url !== 'string') continue;
    try {
      const url = new URL(source.url);
      if (url.protocol === 'https:' && !url.username && !url.password)
        result.push(source.url);
    } catch {
      // A malformed answer is retained in the record, not linked from the manifest.
    }
  }
  return Array.from(new Set(result));
}

function liveRendering(urls: string[]) {
  return urls.map((url) => ({
    id: url,
    type: 'Text',
    label: en('Live upstream realization (mutable URL, not byte-stable)'),
    format: 'text/html'
  }));
}

function summary(context: ContextRecord): Record<string, string[]> | null {
  const caption = answerValue<{
    versions?: { language?: unknown; text?: unknown }[];
  }>(context.modules.context.caption);
  const result: Record<string, string[]> = {};
  for (const version of caption?.versions ?? []) {
    if (
      typeof version?.language !== 'string' ||
      !/^[a-zA-Z-]+$/.test(version.language) ||
      typeof version.text !== 'string' ||
      !version.text
    )
      continue;
    (result[version.language] ??= []).push(version.text);
  }
  return Object.keys(result).length ? result : null;
}

function paintedAssetIds(canvas: IiifResource, prefix: string): string[] {
  const pages = Array.isArray(canvas.items)
    ? (canvas.items as IiifResource[])
    : [];
  const ids: string[] = [];
  for (const page of pages)
    for (const annotation of Array.isArray(page.items)
      ? (page.items as IiifResource[])
      : []) {
      const body = annotation.body as IiifResource | undefined;
      const id = draftAssetId(body?.id, prefix);
      if (id && !ids.includes(id)) ids.push(id);
    }
  return ids;
}

function decorateCanvas(
  canvas: IiifResource,
  prefix: string,
  assets: Map<string, StoredAsset>,
  roles: Map<string, ResourceRole>,
  live: string[]
): IiifResource {
  const painted = paintedAssetIds(canvas, prefix);
  const metadata = painted.map((id) =>
    entry(
      'Resource role',
      `${assets.get(id)!.filename} — ${RESOURCE_ROLE_LABELS[roles.get(id)!]}`
    )
  );
  const surrogates = painted.filter(
    (id) => roles.get(id) === 'documentation_surrogate'
  );
  if (!surrogates.length)
    return { ...canvas, ...(metadata.length ? { metadata } : {}) };
  const dates = surrogates
    .map((id) => captureDate(assets.get(id)!))
    .filter((value): value is string => value !== undefined);
  const title = (canvas.label as { none?: string[] })?.none?.[0] ?? 'Scene';
  const dated = dates.length ? ` (captured ${dates.join(', ')})` : '';
  return {
    ...canvas,
    label: en(`${title} — documentation surrogate${dated}`),
    metadata: [
      ...metadata,
      entry(
        'Documentation surrogate',
        'This canvas presents a documentation surrogate: a recorded viewing of the work, not the complete work.'
      )
    ],
    ...(live.length ? { rendering: liveRendering(live) } : {})
  };
}

function thumbnail(
  selected: StoredAsset[],
  bindings: ResolvedBindings
): IiifResource[] | null {
  const still = selected.find((asset) => {
    const facts = mediaFacts(asset);
    return facts.type === 'Image' && facts.width > 0 && facts.height > 0;
  });
  if (!still) return null;
  const facts = mediaFacts(still);
  return [
    {
      id: bindings.media.get(still.id)!,
      type: 'Image',
      format: facts.mime,
      width: facts.width,
      height: facts.height
    }
  ];
}

function normalizedInput(input: PublicationInput) {
  return {
    snapshot: input.snapshot,
    source_sha256: input.source_sha256,
    selection: {
      asset_ids: [...input.selection.asset_ids].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    },
    bindings: input.bindings,
    rights: input.rights,
    roles: input.roles,
    compiler_version: input.compiler_version,
    ...(input.produced_at === undefined
      ? {}
      : { produced_at: input.produced_at })
  };
}

/**
 * Deterministic IIIF Presentation 3.0 publication of an approved public
 * selection from a verified dossier snapshot. Rejections throw
 * PublicationRejectedError; the returned validation block is the structural
 * self-check of the compiled manifest.
 */
export function compilePublication(
  input: PublicationInput
): CompiledPublication {
  if (input?.compiler_version !== PUBLICATION_COMPILER_VERSION)
    reject(
      'UNSUPPORTED_COMPILER_VERSION',
      `This compiler is ${PUBLICATION_COMPILER_VERSION}.`
    );
  const snapshot = input.snapshot;
  if (
    typeof input.source_sha256 !== 'string' ||
    !SOURCE_HASH.test(input.source_sha256) ||
    dossierSourceHash(snapshot) !== input.source_sha256
  )
    reject(
      'SOURCE_HASH_MISMATCH',
      'The supplied source digest does not match the verified dossier snapshot.'
    );
  const context = snapshot.context;
  const selected = resolveSelection(snapshot, input.selection);
  const roles = resolveRoles(context, selected, input.roles);
  const bindings = resolveBindings(selected, input.bindings);
  const rights = resolveRights(input.rights);
  const prefix = draftPrefix(context);
  const draft = buildIiif(context, selected, prefix);
  const assets = new Map(selected.map((asset) => [asset.id, asset]));
  const live = liveUpstreamUrls(context);
  const canvases = (draft.manifest.items as IiifResource[]).map((canvas) =>
    decorateCanvas(canvas, prefix, assets, roles, live)
  );
  if (!canvases.length)
    reject(
      'NO_PRESENTABLE_CANVAS',
      'A published manifest needs at least one canvas with measured dimensions or duration.'
    );
  const surrogate = selected.some(
    (asset) => roles.get(asset.id) === 'documentation_surrogate'
  );
  const liveWork = isLiveWork(context);
  const renderings = [
    ...((draft.manifest.rendering as IiifResource[] | undefined) ?? []).map(
      (item) => {
        const id = draftAssetId(item.id, prefix)!;
        return {
          ...item,
          label: {
            none: [
              `${assets.get(id)!.filename} — ${RESOURCE_ROLE_LABELS[roles.get(id)!]}`
            ]
          }
        };
      }
    ),
    ...liveRendering(live)
  ];
  const caption = summary(context);
  const thumb = thumbnail(selected, bindings);
  const draftManifest: IiifResource = {
    '@context': IIIF_CONTEXT,
    id: `${prefix}/manifest`,
    type: 'Manifest',
    label: draft.manifest.label,
    ...(caption ? { summary: caption } : {}),
    metadata: [
      entry(
        'Record status',
        'Published presentation compiled from the artist-confirmed dossier snapshot.'
      ),
      entry('Source record digest', `sha256:${input.source_sha256}`),
      entry('Publication compiler', input.compiler_version),
      ...selected.map((asset) =>
        entry(
          'Resource role',
          `${asset.filename} — ${RESOURCE_ROLE_LABELS[roles.get(asset.id)!]}`
        )
      ),
      ...(surrogate
        ? [
            entry(
              'Documentation surrogate',
              'One or more presented resources are documentation surrogates. They record a viewing of the work and are not the complete work.'
            )
          ]
        : []),
      ...(liveWork
        ? [
            entry(
              'Live work',
              'This work is generative, interactive or browser-based. A still or capture presented here is never the complete work.'
            )
          ]
        : [])
    ],
    requiredStatement: entry(rights.statement.label, rights.statement.value),
    rights: rights.iiif,
    ...(rights.provider
      ? {
          provider: [
            {
              id: rights.provider.id,
              type: 'Agent',
              label: en(rights.provider.label)
            }
          ]
        }
      : {}),
    homepage: [
      {
        id: bindings.homepage,
        type: 'Text',
        label: en('Museum object page'),
        format: 'text/html'
      }
    ],
    seeAlso: [
      {
        id: `${prefix}/source`,
        type: 'Dataset',
        label: en('Source dossier record'),
        format: 'application/json'
      }
    ],
    ...(thumb ? { thumbnail: thumb } : {}),
    ...(renderings.length ? { rendering: renderings } : {}),
    items: canvases
  };
  const manifest = rebaseManifest(draftManifest, prefix, bindings);
  const validation = validatePublicationManifest(manifest, {
    base_url: bindings.base,
    media_urls: Array.from(bindings.media.values())
  });
  return {
    manifest,
    source_sha256: input.source_sha256,
    manifest_sha256: digest(manifest),
    transformation: {
      compiler_version: input.compiler_version,
      input_digest: digest(normalizedInput(input)),
      ...(input.produced_at === undefined
        ? {}
        : { produced_at: input.produced_at }),
      issues: draft.issues
    },
    validation
  };
}
