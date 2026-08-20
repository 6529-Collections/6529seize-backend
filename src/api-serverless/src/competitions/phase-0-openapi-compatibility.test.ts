import * as fs from 'node:fs';
import * as path from 'node:path';

const yaml = require('js-yaml') as {
  load(value: string): Record<string, unknown>;
};

type JsonObject = Record<string, any>;

const ACCEPTED_ADDITIVE_ENUM_EXTENSIONS: Readonly<Record<string, string[]>> = {
  'schema ApiNotificationCause.enum': ['SUBSCRIPTION_COVERAGE'],
  'schema ApiPushNotificationSettings.required': ['subscription_coverage']
};

const ACCEPTED_NULLABLE_REFERENCE_EXTENSIONS = new Set([
  'schema ApiNotification.properties.related_identity',
  'schema ApiNotificationV2.properties.related_identity'
]);

const ACCEPTED_REMOVED_REQUIRED_FIELDS: Readonly<Record<string, string[]>> = {
  'schema ApiSeizeSettings.required': [
    'all_drops_notifications_subscribers_limit'
  ]
};

const ACCEPTED_REMOVED_SCHEMA_PROPERTIES = new Set([
  'schema ApiSeizeSettings.properties.all_drops_notifications_subscribers_limit'
]);

const ACCEPTED_REMOVED_RESPONSE_MAX_LENGTHS = new Set([
  'schema ApiDropPart.properties.content.maxLength',
  'schema ApiDropPartV2.properties.content.maxLength'
]);

const ACCEPTED_RELAXED_REQUIRED_FLAGS = new Set([
  'GET /v2/waves/{waveId}/search.parameters.query:term.required'
]);

const fixtureRoot = path.resolve(
  __dirname,
  '../../../competitions/contract-fixtures/phase-0'
);

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function semanticObject(value: unknown): JsonObject {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  return value as JsonObject;
}

function assertSchemaCompatible(
  baseline: unknown,
  current: unknown,
  location: string
): void {
  if (Array.isArray(baseline)) {
    expect(Array.isArray(current)).toBe(true);
    const acceptedAdditions = ACCEPTED_ADDITIVE_ENUM_EXTENSIONS[location] ?? [];
    const acceptedRemovals = new Set(
      ACCEPTED_REMOVED_REQUIRED_FIELDS[location] ?? []
    );
    expect(current).toEqual([
      ...baseline.filter((value) => !acceptedRemovals.has(value)),
      ...acceptedAdditions
    ]);
    return;
  }
  if (baseline === null || typeof baseline !== 'object') {
    if (
      baseline === true &&
      current === false &&
      ACCEPTED_RELAXED_REQUIRED_FLAGS.has(location)
    ) {
      return;
    }
    expect(current).toEqual(baseline);
    return;
  }
  const baselineObject = baseline as JsonObject;
  const currentObject = semanticObject(current);
  if (
    ACCEPTED_NULLABLE_REFERENCE_EXTENSIONS.has(location) &&
    typeof baselineObject.$ref === 'string'
  ) {
    expect(currentObject).toEqual({
      allOf: [{ $ref: baselineObject.$ref }],
      nullable: true
    });
    return;
  }
  for (const [key, baselineValue] of Object.entries(baselineObject)) {
    if (['description', 'example', 'examples', 'title'].includes(key)) continue;
    if (
      key === 'maxLength' &&
      ACCEPTED_REMOVED_RESPONSE_MAX_LENGTHS.has(`${location}.${key}`) &&
      !(key in currentObject)
    ) {
      continue;
    }
    expect(currentObject).toHaveProperty(key);
    if (key === 'properties') {
      const currentProperties = semanticObject(currentObject[key]);
      for (const [property, schema] of Object.entries(
        baselineValue as JsonObject
      )) {
        const propertyLocation = `${location}.properties.${property}`;
        if (ACCEPTED_REMOVED_SCHEMA_PROPERTIES.has(propertyLocation)) {
          expect(currentProperties).not.toHaveProperty(property);
          continue;
        }
        expect(currentProperties).toHaveProperty(property);
        assertSchemaCompatible(
          schema,
          currentProperties[property],
          propertyLocation
        );
      }
      continue;
    }
    assertSchemaCompatible(
      baselineValue,
      currentObject[key],
      `${location}.${key}`
    );
  }
}

function parameterKey(parameter: JsonObject): string {
  return `${parameter.in}:${parameter.name}`;
}

function assertOperationCompatible(
  baseline: JsonObject,
  current: JsonObject,
  location: string
): void {
  expect(current.operationId).toBe(baseline.operationId);
  if ('security' in baseline)
    expect(current.security).toEqual(baseline.security);

  const currentParameters = new Map(
    (current.parameters ?? []).map((parameter: JsonObject) => [
      parameterKey(parameter),
      parameter
    ])
  );
  for (const parameter of baseline.parameters ?? []) {
    const key = parameterKey(parameter);
    const currentParameter = currentParameters.get(key);
    expect(currentParameter).toBeDefined();
    assertSchemaCompatible(
      parameter,
      currentParameter,
      `${location}.parameters.${key}`
    );
  }

  for (const [status, response] of Object.entries(baseline.responses ?? {})) {
    expect(current.responses).toHaveProperty(status);
    assertSchemaCompatible(
      response,
      current.responses[status],
      `${location}.responses.${status}`
    );
  }
}

describe('Phase 0 permanent OpenAPI GET compatibility', () => {
  const baseline = readJson('public-get-openapi-snapshot.json');
  const current = yaml.load(
    fs.readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8')
  ) as JsonObject;

  it('retains the accepted global authentication default', () => {
    expect(current.security).toEqual(baseline.security);
  });

  it('retains every accepted GET operation and its semantic contract', () => {
    let operationCount = 0;
    for (const [route, pathItem] of Object.entries(
      baseline.paths as JsonObject
    )) {
      const baselineGet = (pathItem as JsonObject).get;
      if (!baselineGet) continue;
      operationCount++;
      const currentGet = current.paths?.[route]?.get;
      expect(currentGet).toBeDefined();
      assertOperationCompatible(baselineGet, currentGet, `GET ${route}`);
    }
    expect(operationCount).toBe(baseline.baseline.operation_count);
    expect(operationCount).toBe(183);
  });

  it('retains every schema reachable from the accepted snapshot', () => {
    const baselineSchemas = baseline.components.schemas as JsonObject;
    const currentSchemas = current.components.schemas as JsonObject;
    for (const [name, schema] of Object.entries(baselineSchemas)) {
      expect(currentSchemas).toHaveProperty(name);
      assertSchemaCompatible(schema, currentSchemas[name], `schema ${name}`);
    }
  });
});
