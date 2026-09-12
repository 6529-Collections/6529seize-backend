import { ValueSchema } from '../artwork-documentation.types';

export const text = (maxLength = 12000, description?: string): ValueSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  ...(description ? { description } : {})
});
export const choice = (...values: string[]): ValueSchema => ({
  type: 'string',
  enum: values
});
export const list = (
  items: ValueSchema,
  maxItems = 200,
  minItems = 0
): ValueSchema => ({
  type: 'array',
  items,
  maxItems,
  minItems
});
export const object = (
  properties: Record<string, ValueSchema>,
  required = Object.keys(properties)
): ValueSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});
export const numeric = (
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): ValueSchema => ({ type: 'number', minimum, maximum });
export const integer = (
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): ValueSchema => ({ type: 'integer', minimum, maximum });
export const bool: ValueSchema = { type: 'boolean' };
export const uuid: ValueSchema = { ...text(36), format: 'uuid' };
export const language: ValueSchema = { ...text(64), format: 'bcp47' };
export const uri: ValueSchema = { ...text(2048), format: 'uri' };
export const authorityUri: ValueSchema = {
  ...text(2048),
  format: 'authority-uri'
};
export const assetIds: ValueSchema = { ...list(uuid, 500), uniqueItems: true };
export const date = object(
  {
    precision: choice('day', 'month', 'year', 'range'),
    endpoint_precision: choice('day', 'month', 'year'),
    start: { ...text(10), format: 'partial-date' },
    end: { ...text(10), format: 'partial-date' },
    approximate: bool,
    note: text(2000)
  },
  ['precision', 'start', 'approximate']
);
export const measurement = object(
  {
    id: uuid,
    subject_id: uuid,
    kind: choice(
      'width',
      'height',
      'depth',
      'diameter',
      'duration',
      'weight',
      'resolution',
      'frame_rate',
      'sample_rate',
      'bit_depth',
      'channels',
      'scale',
      'other'
    ),
    scope: choice(
      'image',
      'sheet',
      'frame',
      'object',
      'digital_file',
      'playback',
      'installation',
      'other'
    ),
    value: numeric(),
    unit: choice(
      'px',
      'mm',
      'cm',
      'm',
      'in',
      's',
      'ms',
      'kg',
      'g',
      'ppi',
      'fps',
      'Hz',
      'bit',
      'channel',
      'ratio',
      'other'
    ),
    unit_label: text(300),
    precision: text(100),
    note: text(2000)
  },
  ['id', 'subject_id', 'kind', 'scope', 'value', 'unit']
);
export const attribution = object(
  {
    agent_id: uuid,
    role: text(160),
    credit: text(1000)
  },
  ['agent_id', 'role']
);
export const source = object(
  {
    id: uuid,
    kind: choice(
      'book',
      'article',
      'notebook',
      'interview',
      'website',
      'archive',
      'artwork',
      'document',
      'other'
    ),
    title: text(1000),
    citation: text(12000),
    url: uri,
    asset_id: uuid,
    language,
    note: text(6000)
  },
  ['id', 'kind', 'title']
);
export const authority = object(
  {
    authority: choice(
      'AAT',
      'ULAN',
      'TGN',
      'VIAF',
      'Wikidata',
      'PRONOM',
      'other'
    ),
    identifier: text(300),
    uri: authorityUri,
    label: text(1000),
    match: choice(
      'suggested',
      'exact',
      'close',
      'broader',
      'narrower',
      'unresolved'
    ),
    evidence: text(6000),
    source_url: uri,
    retrieved_at: { ...text(10), format: 'partial-date' }
  },
  ['authority', 'identifier', 'uri', 'label', 'match', 'evidence']
);
