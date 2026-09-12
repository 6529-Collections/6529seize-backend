import { ContextRecord } from '../../artwork-documentation.types';
import { answerValue } from '../../artwork-documentation.validation';
import { StoredAsset } from '../../assets/artwork-assets.types';
import { MuseumPresentationScene } from '../museum-record.types';
import {
  annotation,
  annotationPage,
  contentResource,
  fragment,
  IiifEnvironment,
  iiifIssue,
  IiifResource,
  mediaFacts,
  paintingResource,
  sceneExtent,
  textBody,
  validRegion
} from './iiif-resources';
import { interviewAnnotations } from './iiif-interviews';

function defaultScenes(
  context: ContextRecord,
  env: IiifEnvironment
): MuseumPresentationScene[] {
  return context.asset_links
    .filter((link) =>
      [
        'artwork_final',
        'display_derivative',
        'reference_capture',
        'interview_recording'
      ].includes(link.role)
    )
    .flatMap((link) => {
      const asset = env.assets.get(link.asset_id);
      if (!asset) return [];
      if (!mediaFacts(asset).paintable) {
        iiifIssue(
          env,
          `asset:${asset.id}`,
          'This original is available as a download. Measured dimensions or duration do not support a painting canvas.'
        );
        return [];
      }
      return [
        {
          id: link.id,
          title: link.label || asset.filename,
          resources: [{ asset_id: asset.id, role: 'painting' as const }]
        }
      ];
    });
}
function sceneAnnotations(
  scene: MuseumPresentationScene,
  env: IiifEnvironment
): IiifResource[] {
  const canvasId = `${env.prefix}/canvas/${scene.id}`;
  const result: IiifResource[] = [];
  for (const item of scene.annotations ?? []) {
    const valid = validRegion(item, sceneExtent(scene, env));
    if (!valid)
      iiifIssue(
        env,
        `scene:${scene.id}/annotation:${item.id}`,
        'The annotation is retained on the whole scene because its stated position or timing exceeds the available scene bounds.'
      );
    const target = valid ? fragment(canvasId, item) : canvasId;
    if (item.text)
      result.push(
        annotation(
          `${env.prefix}/annotation/${scene.id}/${item.id}/text`,
          target,
          textBody(item.text, item.language),
          item.kind === 'description' ? 'commenting' : 'supplementing'
        )
      );
    if (item.asset_id) {
      const body = contentResource(env, item.asset_id);
      if (body)
        result.push(
          annotation(
            `${env.prefix}/annotation/${scene.id}/${item.id}/file`,
            target,
            { ...body, language: item.language }
          )
        );
    }
  }
  return result;
}
function canvas(
  scene: MuseumPresentationScene,
  context: ContextRecord,
  env: IiifEnvironment
): IiifResource | null {
  const extent = sceneExtent(scene, env);
  if (!extent.width && !extent.duration) {
    iiifIssue(
      env,
      `scene:${scene.id}`,
      'This scene has no measured or declared extent. Its instructions remain in the complete record.'
    );
    return null;
  }
  const paintings = scene.resources.flatMap((resource, index) => {
    if (resource.role !== 'painting') return [];
    const value = paintingResource(scene, resource, index, env);
    return value ? [value] : [];
  });
  const supplements = scene.resources.flatMap((resource, index) => {
    if (resource.role !== 'supplementary') return [];
    const body = contentResource(env, resource.asset_id);
    const valid = validRegion(resource, extent);
    if (!valid)
      iiifIssue(
        env,
        `scene:${scene.id}/supplement:${index}`,
        'The supplementary file is retained on the whole scene because its stated position or timing exceeds the available scene bounds.'
      );
    return body
      ? [
          annotation(
            `${env.prefix}/annotation/${scene.id}/supplement-${index}`,
            valid
              ? fragment(`${env.prefix}/canvas/${scene.id}`, resource)
              : `${env.prefix}/canvas/${scene.id}`,
            body
          )
        ]
      : [];
  });
  const annotations = [
    ...supplements,
    ...sceneAnnotations(scene, env),
    ...interviewAnnotations(context, scene, env)
  ];
  return {
    id: `${env.prefix}/canvas/${scene.id}`,
    type: 'Canvas',
    label: { none: [scene.title] },
    ...extent,
    items: [
      annotationPage(`${env.prefix}/page/${scene.id}/painting`, paintings)
    ],
    ...(annotations.length
      ? {
          annotations: [
            annotationPage(
              `${env.prefix}/page/${scene.id}/annotations`,
              annotations
            )
          ]
        }
      : {})
  };
}

/** Presentation API 3.0 draft projection. Only an eventual publication adapter binds and serves these URLs. */
export function buildIiif(
  context: ContextRecord,
  assets: StoredAsset[],
  base: string
) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('IIIF requires an HTTP(S) publication base');
  const env: IiifEnvironment = {
    prefix: base.replace(/\/$/, ''),
    assets: new Map(assets.map((asset) => [asset.id, asset])),
    bindings: {},
    issues: []
  };
  const declared =
    answerValue<MuseumPresentationScene[]>(
      context.modules.preservation.presentation_scenes
    ) ?? [];
  const scenes = declared.length ? declared : defaultScenes(context, env);
  const items = scenes.flatMap((scene) => {
    const value = canvas(scene, context, env);
    return value ? [value] : [];
  });
  const rendering = assets.map((asset) => contentResource(env, asset.id)!);
  const manifest = {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: `${env.prefix}/manifest`,
    type: 'Manifest',
    label: {
      none: [
        answerValue<string>(context.modules.artwork.title) ??
          'Artwork record — title not supplied'
      ]
    },
    metadata: [
      {
        label: { en: ['Record status'] },
        value: {
          en: [
            'Draft export; publication URLs must be bound before serving this manifest.'
          ]
        }
      }
    ],
    ...(rendering.length ? { rendering } : {}),
    items
  };
  return { manifest, bindings: env.bindings, issues: env.issues };
}
