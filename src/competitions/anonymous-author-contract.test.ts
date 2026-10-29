import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiIdentityOverview } from '@/api/generated/models/ApiIdentityOverview';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { anonymousCompetitionAuthor } from './competition-anonymity';

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
};
const document = parse(
  readFileSync(resolve(__dirname, '../api-serverless/openapi.yaml'), 'utf8')
) as { components: { schemas: Record<string, Schema> } };

function expectObject(value: unknown, schema: Schema): void {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  const object = value as Record<string, unknown>;
  for (const key of schema.required ?? []) expect(object).toHaveProperty(key);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key in object) expectSchema(object[key], property);
  }
}

/** Validate actual serialized projections against the independently owned API. */
function expectSchema(value: unknown, schema: Schema): void {
  if (schema.$ref) {
    expectSchema(
      value,
      document.components.schemas[schema.$ref.split('/').pop()!]
    );
    return;
  }
  for (const part of schema.allOf ?? []) expectSchema(value, part);
  if (schema.nullable && value === null) return;
  if (schema.enum) expect(schema.enum).toContain(value);
  if (schema.type === 'object') expectObject(value, schema);
  else if (schema.type === 'array') {
    expect(Array.isArray(value)).toBe(true);
    if (schema.items)
      for (const item of value as unknown[]) expectSchema(item, schema.items);
  } else if (schema.type === 'integer')
    expect(Number.isInteger(value)).toBe(true);
  else if (schema.type) expect(typeof value).toBe(schema.type);
}

const profile: ApiProfileMin = {
  id: 'private-owner',
  handle: 'private-handle',
  primary_address: 'private-wallet',
  pfp: 'private-picture',
  banner1_color: 'private-color',
  banner2_color: 'private-color',
  cic: 10,
  rep: 20,
  tdh: 30,
  tdh_rate: 40,
  xtdh: 50,
  xtdh_rate: 60,
  level: 3,
  classification: ApiProfileClassification.Pseudonym,
  sub_classification: null,
  subscribed_actions: [],
  archived: false,
  active_main_stage_submission_ids: ['private-entry'],
  winner_main_stage_drop_ids: ['private-winner'],
  artist_of_prevote_cards: [1],
  profile_wave_id: 'private-wave',
  is_wave_creator: true
};
const overview: ApiIdentityOverview = {
  id: profile.id,
  handle: profile.handle!,
  primary_address: profile.primary_address,
  pfp: profile.pfp!,
  level: profile.level,
  classification: profile.classification,
  badges: {
    artist_of_main_stage_submissions: 2,
    artist_of_memes: 3,
    profile_wave_id: 'private-wave'
  }
};
const identity: ApiIdentity = {
  ...profile,
  normalised_handle: 'private-handle',
  display: 'private-display',
  consolidation_key: 'private-consolidation',
  primary_wallet: 'private-wallet',
  banner1: 'private-banner',
  banner2: 'private-banner'
};

it.each([
  { schema: 'ApiProfileMin', profile },
  { schema: 'ApiIdentity', profile: identity },
  { schema: 'ApiIdentityOverview', profile: overview },
  {
    schema: 'ApiDropResolvedIdentityProfile',
    profile: { ...profile, bio: 'private biography', top_rep_categories: [] }
  },
  {
    schema: 'ApiDropResolvedIdentityProfileV2',
    profile: { ...overview, bio: 'private biography', top_rep_categories: [] }
  }
])(
  'preserves the $schema wire contract while hiding identity',
  ({ schema, profile: input }) => {
    const serialized = JSON.stringify(
      anonymousCompetitionAuthor(input, 'drop')
    );
    expectSchema(JSON.parse(serialized), document.components.schemas[schema]);
    expect(serialized).not.toContain('private-');
  }
);
