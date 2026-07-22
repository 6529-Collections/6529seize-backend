import * as fs from 'node:fs';
import * as path from 'node:path';

const yaml = require('js-yaml') as {
  load(value: string): Record<string, unknown>;
};

type JsonObject = Record<string, any>;

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
    expect(current).toEqual(baseline);
    return;
  }
  if (baseline === null || typeof baseline !== 'object') {
    expect(current).toEqual(baseline);
    return;
  }
  const baselineObject = baseline as JsonObject;
  const currentObject = semanticObject(current);
  for (const [key, baselineValue] of Object.entries(baselineObject)) {
    if (['description', 'example', 'examples', 'title'].includes(key)) continue;
    expect(currentObject).toHaveProperty(key);
    if (key === 'properties') {
      const currentProperties = semanticObject(currentObject[key]);
      for (const [property, schema] of Object.entries(
        baselineValue as JsonObject
      )) {
        expect(currentProperties).toHaveProperty(property);
        assertSchemaCompatible(
          schema,
          currentProperties[property],
          `${location}.properties.${property}`
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
