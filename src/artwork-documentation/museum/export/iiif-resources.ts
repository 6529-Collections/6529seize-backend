import { parseJson } from '../../artwork-documentation.db';
import {
  AssetTechnicalMetadata,
  StoredAsset
} from '../../assets/artwork-assets.types';
import { MuseumPresentationScene } from '../museum-record.types';
import { DossierIssue } from './dossier.types';

export type IiifResource = Record<string, unknown>;
export type SceneResource = MuseumPresentationScene['resources'][number];
export interface IiifEnvironment {
  prefix: string;
  assets: Map<string, StoredAsset>;
  bindings: Record<string, string>;
  issues: DossierIssue[];
}
export function iiifIssue(env: IiifEnvironment, path: string, message: string) {
  env.issues.push({
    code: 'IIIF_PRESENTATION_REVIEW',
    path,
    severity: 'warning',
    message
  });
}
export function mediaFacts(asset: StoredAsset) {
  const metadata = asset.technical_metadata_json
    ? parseJson<AssetTechnicalMetadata>(asset.technical_metadata_json)
    : null;
  const mime = asset.detected_mime ?? 'application/octet-stream';
  const type = mime.startsWith('image/')
    ? 'Image'
    : mime.startsWith('video/')
      ? 'Video'
      : mime.startsWith('audio/')
        ? 'Sound'
        : mime.startsWith('text/') || mime === 'application/pdf'
          ? 'Text'
          : 'Dataset';
  const duration = Number(metadata?.properties.duration_seconds ?? 0);
  const width = Number(asset.width ?? 0),
    height = Number(asset.height ?? 0);
  const spatial = type === 'Image' || type === 'Video';
  const temporal = type === 'Video' || type === 'Sound';
  return {
    type,
    mime,
    width,
    height,
    duration,
    spatial,
    temporal,
    paintable:
      ['Image', 'Video', 'Sound'].includes(type) &&
      (!spatial || (width > 0 && height > 0)) &&
      (!temporal || (Number.isFinite(duration) && duration > 0))
  };
}
export function contentResource(
  env: IiifEnvironment,
  assetId: string
): IiifResource | null {
  const asset = env.assets.get(assetId);
  if (!asset) {
    iiifIssue(
      env,
      `asset:${assetId}`,
      'The referenced file is not in this dossier.'
    );
    return null;
  }
  const facts = mediaFacts(asset);
  const id = `${env.prefix}/originals/${asset.id}`;
  env.bindings[id] = `data/originals/${asset.id}.${asset.extension}`;
  return {
    id,
    type: facts.type,
    format: facts.mime,
    label: { none: [asset.filename] },
    ...(facts.spatial && facts.width > 0 && facts.height > 0
      ? { width: facts.width, height: facts.height }
      : {}),
    ...(facts.temporal && facts.duration > 0
      ? { duration: facts.duration }
      : {})
  };
}
export function fragment(
  id: string,
  region: {
    start_seconds?: number;
    end_seconds?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }
) {
  const parts: string[] = [];
  if (region.width !== undefined && region.height !== undefined)
    parts.push(
      `xywh=${region.x ?? 0},${region.y ?? 0},${region.width},${region.height}`
    );
  if (region.start_seconds !== undefined || region.end_seconds !== undefined)
    parts.push(`t=${region.start_seconds ?? 0},${region.end_seconds ?? ''}`);
  return id + (parts.length ? '#' + parts.join('&') : '');
}
export function annotation(
  id: string,
  target: string,
  body: IiifResource,
  motivation = 'supplementing'
): IiifResource {
  return { id, type: 'Annotation', motivation, body, target };
}
export function annotationPage(
  id: string,
  items: IiifResource[]
): IiifResource {
  return { id, type: 'AnnotationPage', items };
}
export function textBody(value: string, language: string): IiifResource {
  return { type: 'TextualBody', value, format: 'text/plain', language };
}

export function validRegion(
  region: Parameters<typeof fragment>[1],
  extent: { width?: number; height?: number; duration?: number }
): boolean {
  const timed =
    region.start_seconds !== undefined || region.end_seconds !== undefined;
  const spatial = [region.x, region.y, region.width, region.height].some(
    (value) => value !== undefined
  );
  const start = region.start_seconds ?? 0;
  const end = region.end_seconds ?? extent.duration ?? 0;
  return (
    (!timed ||
      (Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end > start &&
        end <= (extent.duration ?? 0))) &&
    (!spatial ||
      (region.width !== undefined &&
        region.height !== undefined &&
        region.width > 0 &&
        region.height > 0 &&
        (region.x ?? 0) >= 0 &&
        (region.y ?? 0) >= 0 &&
        (region.x ?? 0) + region.width <= (extent.width ?? 0) &&
        (region.y ?? 0) + region.height <= (extent.height ?? 0)))
  );
}

export function sceneExtent(
  scene: MuseumPresentationScene,
  env: IiifEnvironment
) {
  let width = scene.width ?? 0,
    height = scene.height ?? 0,
    duration = scene.duration_seconds ?? 0;
  for (const resource of scene.resources.filter(
    (item) => item.role === 'painting'
  )) {
    const asset = env.assets.get(resource.asset_id);
    if (!asset) continue;
    const facts = mediaFacts(asset);
    if (!facts.paintable) continue;
    if (scene.width === undefined && facts.spatial)
      width = Math.max(
        width,
        (resource.x ?? 0) + (resource.width ?? facts.width)
      );
    if (scene.height === undefined && facts.spatial)
      height = Math.max(
        height,
        (resource.y ?? 0) + (resource.height ?? facts.height)
      );
    if (scene.duration_seconds === undefined && facts.temporal)
      duration = Math.max(
        duration,
        resource.end_seconds ??
          (resource.start_seconds ?? 0) +
            (resource.source_end_seconds ?? facts.duration) -
            (resource.source_start_seconds ?? 0)
      );
  }
  return {
    ...(width > 0 && height > 0 ? { width, height } : {}),
    ...(duration > 0 ? { duration } : {})
  };
}
export function paintingResource(
  scene: MuseumPresentationScene,
  resource: SceneResource,
  index: number,
  env: IiifEnvironment
): IiifResource | null {
  const asset = env.assets.get(resource.asset_id);
  const body = contentResource(env, resource.asset_id);
  if (!asset || !body) return null;
  const facts = mediaFacts(asset),
    extent = sceneExtent(scene, env);
  const validTime =
    validRegion(resource, extent) &&
    (facts.temporal
      ? (resource.source_start_seconds ?? 0) >= 0 &&
        (resource.source_start_seconds ?? 0) <
          (resource.source_end_seconds ?? facts.duration) &&
        (resource.source_end_seconds ?? facts.duration) <= facts.duration
      : resource.source_start_seconds === undefined &&
        resource.source_end_seconds === undefined);
  const validSpace =
    !facts.spatial ||
    ((resource.x ?? 0) + (resource.width ?? extent.width ?? 0) <=
      (extent.width ?? 0) &&
      (resource.y ?? 0) + (resource.height ?? extent.height ?? 0) <=
        (extent.height ?? 0));
  if (!facts.paintable || !validTime || !validSpace) {
    iiifIssue(
      env,
      `scene:${scene.id}/resource:${index}`,
      'Measured media facts or the scene bounds do not support this painting. The original and the complete presentation instructions are retained.'
    );
    return null;
  }
  body.id = fragment(String(body.id), {
    start_seconds: resource.source_start_seconds,
    end_seconds: resource.source_end_seconds
  });
  return {
    ...annotation(
      `${env.prefix}/annotation/${scene.id}/resource-${index}`,
      fragment(`${env.prefix}/canvas/${scene.id}`, resource),
      body,
      'painting'
    ),
    ...(resource.time_mode ? { timeMode: resource.time_mode } : {})
  };
}
