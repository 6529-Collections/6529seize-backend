import { isIiifRegistryRightsUri } from './publication-rights';
import {
  PublicationValidation,
  PublicationValidationError
} from './publication.types';

type Node = Record<string, unknown>;
const CONTEXT = 'http://iiif.io/api/presentation/3/context.json'; // NOSONAR: canonical IIIF namespace identifier, never fetched.
const LANGUAGE = /^([a-zA-Z-]+|none)$/;

export interface PublicationExpectations {
  base_url: string;
  media_urls: string[];
}

class Collector {
  readonly errors: PublicationValidationError[] = [];
  fail(path: string, code: string, message: string) {
    this.errors.push({ path, code, message });
  }
}

const isNode = (value: unknown): value is Node =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isHttps = (value: unknown) =>
  typeof value === 'string' && /^https:\/\/[^\s/]+/.test(value);
const isHttp = (value: unknown) =>
  typeof value === 'string' && /^https?:\/\/[^\s/]+/.test(value);
const withoutFragment = (value: string) => value.split('#')[0];

function languageMap(
  value: unknown,
  path: string,
  errors: Collector,
  required = true
): void {
  if (value === undefined) {
    if (required) errors.fail(path, 'LANGUAGE_MAP_REQUIRED', 'Missing.');
    return;
  }
  if (!isNode(value) || !Object.keys(value).length) {
    errors.fail(path, 'LANGUAGE_MAP_INVALID', 'Expected a language map.');
    return;
  }
  for (const [language, strings] of Object.entries(value))
    if (
      !LANGUAGE.test(language) ||
      !Array.isArray(strings) ||
      !strings.length ||
      !strings.every((item) => typeof item === 'string')
    )
      errors.fail(
        `${path}.${language}`,
        'LANGUAGE_MAP_INVALID',
        'Each language needs a non-empty array of strings.'
      );
}

function keyValue(value: unknown, path: string, errors: Collector) {
  if (!isNode(value)) {
    errors.fail(path, 'KEY_VALUE_INVALID', 'Expected label and value.');
    return;
  }
  languageMap(value.label, `${path}.label`, errors);
  languageMap(value.value, `${path}.value`, errors);
}

function linked(
  value: unknown,
  path: string,
  errors: Collector,
  allowed: Set<string> | null
) {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length) {
    errors.fail(
      path,
      'LINKED_RESOURCES_INVALID',
      'Expected a non-empty array.'
    );
    return;
  }
  value.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (!isNode(item) || !isHttp(item.id) || typeof item.type !== 'string')
      errors.fail(
        at,
        'LINKED_RESOURCE_INVALID',
        'Needs an http(s) id and type.'
      );
    else if (allowed && !allowed.has(withoutFragment(item.id as string)))
      errors.fail(at, 'UNBOUND_URL', 'URL is not a bound publication URL.');
    languageMap(item.label, `${at}.label`, errors, false);
  });
}

function contentResource(
  body: unknown,
  path: string,
  errors: Collector,
  media: Set<string>
) {
  if (!isNode(body)) {
    errors.fail(path, 'BODY_INVALID', 'Painting body must be a resource.');
    return;
  }
  if (!isHttps(body.id))
    errors.fail(`${path}.id`, 'BODY_ID_INVALID', 'Needs an https id.');
  else if (!media.has(withoutFragment(body.id as string)))
    errors.fail(`${path}.id`, 'MEDIA_NOT_BOUND', 'Media URL is not bound.');
  if (
    !['Image', 'Video', 'Sound', 'Text', 'Dataset', 'Model'].includes(
      String(body.type)
    )
  )
    errors.fail(
      `${path}.type`,
      'BODY_TYPE_INVALID',
      'Unsupported content type.'
    );
  if (typeof body.format !== 'string' || !/^[a-z]+\/.+/.test(body.format))
    errors.fail(`${path}.format`, 'BODY_FORMAT_INVALID', 'Needs a media type.');
}

function canvas(
  item: unknown,
  path: string,
  errors: Collector,
  base: string,
  media: Set<string>
) {
  if (!isNode(item)) {
    errors.fail(path, 'CANVAS_INVALID', 'Expected a Canvas object.');
    return;
  }
  if (typeof item.id !== 'string' || !item.id.startsWith(`${base}/canvas/`))
    errors.fail(
      `${path}.id`,
      'CANVAS_ID_INVALID',
      'Canvas id is not under the base.'
    );
  if (item.type !== 'Canvas')
    errors.fail(`${path}.type`, 'CANVAS_TYPE_INVALID', 'Expected Canvas.');
  languageMap(item.label, `${path}.label`, errors);
  const dimension = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;
  const spatial = dimension(item.width) && dimension(item.height);
  const temporal = typeof item.duration === 'number' && item.duration > 0;
  if (!spatial && !temporal)
    errors.fail(
      path,
      'CANVAS_EXTENT_REQUIRED',
      'Needs width+height or duration.'
    );
  if ((item.width === undefined) !== (item.height === undefined))
    errors.fail(path, 'CANVAS_EXTENT_INVALID', 'Width and height go together.');
  if (!Array.isArray(item.items) || !item.items.length) {
    errors.fail(
      `${path}.items`,
      'PAINTING_PAGE_REQUIRED',
      'Needs annotation pages.'
    );
    return;
  }
  let paintings = 0;
  item.items.forEach((page, pageIndex) => {
    const at = `${path}.items[${pageIndex}]`;
    if (
      !isNode(page) ||
      !isHttps(page.id) ||
      page.type !== 'AnnotationPage' ||
      !Array.isArray(page.items)
    ) {
      errors.fail(
        at,
        'ANNOTATION_PAGE_INVALID',
        'Needs id, type AnnotationPage and items.'
      );
      return;
    }
    page.items.forEach((annotation, index) => {
      const here = `${at}.items[${index}]`;
      if (
        !isNode(annotation) ||
        !isHttps(annotation.id) ||
        annotation.type !== 'Annotation'
      ) {
        errors.fail(
          here,
          'ANNOTATION_INVALID',
          'Needs id and type Annotation.'
        );
        return;
      }
      if (annotation.motivation !== 'painting')
        errors.fail(
          `${here}.motivation`,
          'PAINTING_REQUIRED',
          'Canvas items must paint.'
        );
      else paintings++;
      if (
        typeof annotation.target !== 'string' ||
        withoutFragment(annotation.target) !== item.id
      )
        errors.fail(
          `${here}.target`,
          'TARGET_INVALID',
          'Must target this canvas.'
        );
      contentResource(annotation.body, `${here}.body`, errors, media);
    });
  });
  if (!paintings)
    errors.fail(
      path,
      'PAINTING_REQUIRED',
      'Needs at least one painting annotation.'
    );
  linked(item.rendering, `${path}.rendering`, errors, null);
  if (item.metadata !== undefined) {
    if (!Array.isArray(item.metadata))
      errors.fail(`${path}.metadata`, 'METADATA_INVALID', 'Expected an array.');
    else
      item.metadata.forEach((pair, index) =>
        keyValue(pair, `${path}.metadata[${index}]`, errors)
      );
  }
}

/** Structural IIIF Presentation 3.0 checks for a compiled publication manifest. */
export function validatePublicationManifest(
  manifest: unknown,
  expectations: PublicationExpectations
): PublicationValidation {
  const errors = new Collector();
  if (!isNode(manifest))
    return {
      ok: false,
      errors: [
        { path: '', code: 'MANIFEST_INVALID', message: 'Expected an object.' }
      ]
    };
  const base = expectations.base_url;
  const media = new Set(expectations.media_urls);
  const keys = Object.keys(manifest);
  if (keys[0] !== '@context' || manifest['@context'] !== CONTEXT)
    errors.fail(
      '@context',
      'CONTEXT_FIRST',
      'The IIIF context must be the first member.'
    );
  if (manifest.id !== `${base}/manifest`)
    errors.fail(
      'id',
      'MANIFEST_ID_INVALID',
      'Manifest id must be <base>/manifest.'
    );
  if (manifest.type !== 'Manifest')
    errors.fail('type', 'MANIFEST_TYPE_INVALID', 'Expected Manifest.');
  languageMap(manifest.label, 'label', errors);
  languageMap(manifest.summary, 'summary', errors, false);
  if (!isIiifRegistryRightsUri(manifest.rights))
    errors.fail(
      'rights',
      'RIGHTS_NOT_IN_REGISTRY',
      'Rights must be a registry URI in http form.'
    );
  keyValue(manifest.requiredStatement, 'requiredStatement', errors);
  if (manifest.provider !== undefined) {
    if (!Array.isArray(manifest.provider) || !manifest.provider.length)
      errors.fail(
        'provider',
        'PROVIDER_INVALID',
        'Expected a non-empty array.'
      );
    else
      manifest.provider.forEach((agent, index) => {
        if (!isNode(agent) || !isHttps(agent.id) || agent.type !== 'Agent')
          errors.fail(
            `provider[${index}]`,
            'PROVIDER_INVALID',
            'Needs https id and type Agent.'
          );
        else languageMap(agent.label, `provider[${index}].label`, errors);
      });
  }
  linked(manifest.homepage, 'homepage', errors, null);
  linked(manifest.seeAlso, 'seeAlso', errors, null);
  if (
    !Array.isArray(manifest.seeAlso) ||
    !manifest.seeAlso.some(
      (item) => isNode(item) && item.id === `${base}/source`
    )
  )
    errors.fail(
      'seeAlso',
      'SOURCE_LINK_REQUIRED',
      'Must link the source dossier record.'
    );
  linked(manifest.rendering, 'rendering', errors, null);
  if (manifest.thumbnail !== undefined) {
    if (!Array.isArray(manifest.thumbnail) || !manifest.thumbnail.length)
      errors.fail(
        'thumbnail',
        'THUMBNAIL_INVALID',
        'Expected a non-empty array.'
      );
    else
      manifest.thumbnail.forEach((item, index) =>
        contentResource(item, `thumbnail[${index}]`, errors, media)
      );
  }
  if (!Array.isArray(manifest.metadata) || !manifest.metadata.length)
    errors.fail('metadata', 'METADATA_REQUIRED', 'Expected metadata entries.');
  else
    manifest.metadata.forEach((pair, index) =>
      keyValue(pair, `metadata[${index}]`, errors)
    );
  if (!Array.isArray(manifest.items) || !manifest.items.length)
    errors.fail(
      'items',
      'CANVAS_REQUIRED',
      'A published manifest needs at least one canvas.'
    );
  else
    manifest.items.forEach((item, index) =>
      canvas(item, `items[${index}]`, errors, base, media)
    );
  for (const key of keys)
    if (
      ![
        '@context',
        'id',
        'type',
        'label',
        'summary',
        'metadata',
        'requiredStatement',
        'rights',
        'provider',
        'homepage',
        'seeAlso',
        'thumbnail',
        'rendering',
        'items'
      ].includes(key)
    )
      errors.fail(key, 'UNEXPECTED_MEMBER', 'Unexpected manifest member.');
  return { ok: !errors.errors.length, errors: errors.errors };
}
