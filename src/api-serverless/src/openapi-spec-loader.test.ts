import SwaggerParser from '@apidevtools/swagger-parser';
import express from 'express';
import * as path from 'node:path';
import { Server } from 'node:http';
import { parse as parseYamlIndependently } from 'yaml';
import { loadOpenApiSpec, parseOpenApiDocument } from './openapi-spec-loader';
import { registerOpenApiSpecRoutes } from './openapi-spec-routes';

const SPEC_PATH = path.resolve(__dirname, '..', 'openapi.yaml');

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface Leaf {
  readonly pointer: string;
  readonly key: string;
  readonly value: JsonValue;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/[~/]/g, (match) => (match === '~' ? '~0' : '~1'));
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~[01]/g, (match) => (match === '~0' ? '~' : '/'));
}

function collectLeaves(value: JsonValue, pointer: string, into: Leaf[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectLeaves(item, `${pointer}/${index}`, into)
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointerSegment(key)}`;
      if (item && typeof item === 'object') {
        collectLeaves(item, childPointer, into);
      } else {
        into.push({ pointer: childPointer, key, value: item });
      }
    }
  }
}

function leaves(value: JsonValue): Leaf[] {
  const into: Leaf[] = [];
  collectLeaves(value, '', into);
  return into;
}

function resolvePointer(
  document: JsonValue,
  ref: string
): JsonValue | undefined {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  let current: JsonValue | undefined = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = unescapePointerSegment(rawSegment);
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as { [key: string]: JsonValue })[segment];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

// Keys whose values the OpenAPI object model defines as strings. Leaves under
// `example`/`examples`/`default`/`enum` are deliberately not listed: those are
// user data and may legitimately be numbers.
const STRING_VALUED_KEYS = new Set([
  '$ref',
  'pattern',
  'description',
  'summary',
  'title',
  'operationId',
  'format'
]);

const EXAMPLE_CONTAINERS = new Set(['example', 'examples', 'default', 'enum']);

function isUnderExampleContainer(pointer: string): boolean {
  return pointer
    .split('/')
    .slice(0, -1)
    .some((segment) => EXAMPLE_CONTAINERS.has(segment));
}

async function withServedSpec<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  const spec = loadOpenApiSpec(SPEC_PATH);
  registerOpenApiSpecRoutes(app, spec.raw, spec.document);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('openapi spec loader', () => {
  // These are the two constructs the previous loader (yamljs) mangled: a
  // folded block scalar starting with `#` parsed to "" and a quoted string
  // starting with `0x` parsed to a number. The expected values are literals,
  // not the output of any parser.
  it('keeps a folded $ref and 0x-prefixed strings intact', () => {
    const snippet = [
      'components:',
      '  schemas:',
      '    Wrapper:',
      '      properties:',
      '        config:',
      '          $ref: >-',
      '            #/components/schemas/VeryLongSchemaNameThatRestructureWrapsOntoItsOwnLine',
      '        address:',
      '          type: string',
      '          pattern: "0x[a-fA-F0-9]{40}"',
      '          description: "0x-prefixed 40-character hex address"',
      ''
    ].join('\n');

    const document = parseOpenApiDocument(snippet, 'snippet.yaml');
    const wrapper = (
      (document.components as { schemas: Record<string, JsonValue> }).schemas
        .Wrapper as { properties: Record<string, Record<string, JsonValue>> }
    ).properties;

    expect(wrapper.config.$ref).toBe(
      '#/components/schemas/VeryLongSchemaNameThatRestructureWrapsOntoItsOwnLine'
    );
    expect(wrapper.address.pattern).toBe('0x[a-fA-F0-9]{40}');
    expect(wrapper.address.description).toBe(
      '0x-prefixed 40-character hex address'
    );
  });

  it('rejects input that is not a document object', () => {
    expect(() => parseOpenApiDocument('- just\n- a list\n')).toThrow(
      /did not parse to an OpenAPI document object/
    );
    expect(() => parseOpenApiDocument('')).toThrow(
      /did not parse to an OpenAPI document object/
    );
  });

  describe('the checked-in openapi.yaml through the production loader', () => {
    const { document } = loadOpenApiSpec(SPEC_PATH);
    const allLeaves = leaves(document as JsonValue);

    it('has every $ref as a local pointer that resolves to a schema object', () => {
      const refs = allLeaves.filter((leaf) => leaf.key === '$ref');
      expect(refs.length).toBeGreaterThan(1000);
      const broken = refs
        .filter(
          (leaf) =>
            typeof leaf.value !== 'string' ||
            !leaf.value.startsWith('#/components/') ||
            resolvePointer(document as JsonValue, leaf.value) === undefined
        )
        .map((leaf) => `${leaf.pointer} = ${JSON.stringify(leaf.value)}`);
      expect(broken).toEqual([]);
    });

    it('keeps every string-typed OpenAPI field a string', () => {
      const wrongType = allLeaves
        .filter(
          (leaf) =>
            STRING_VALUED_KEYS.has(leaf.key) &&
            !isUnderExampleContainer(leaf.pointer) &&
            typeof leaf.value !== 'string'
        )
        .map((leaf) => `${leaf.pointer} = ${JSON.stringify(leaf.value)}`);
      expect(wrongType).toEqual([]);
    });

    it('dereferences with swagger-parser without dangling references', async () => {
      const api = await SwaggerParser.dereference(
        JSON.parse(JSON.stringify(document))
      );
      expect(Object.keys(api.paths ?? {}).length).toBeGreaterThan(100);
    });
  });

  it('serves YAML and JSON that are semantically equivalent', async () => {
    await withServedSpec(async (baseUrl) => {
      const [yamlResponse, jsonResponse] = await Promise.all([
        fetch(`${baseUrl}/openapi.yaml`),
        fetch(`${baseUrl}/openapi.json`)
      ]);
      expect(yamlResponse.status).toBe(200);
      expect(jsonResponse.status).toBe(200);
      const yamlText = await yamlResponse.text();
      const json = (await jsonResponse.json()) as {
        components: {
          schemas: Record<
            string,
            { properties: Record<string, { $ref?: string }> }
          >;
        };
      };
      // `yaml` is an independent YAML 1.2 implementation from the one the
      // loader uses (js-yaml), so agreement here is not self-confirmation.
      const independentlyParsed = parseYamlIndependently(yamlText);
      expect(json).toEqual(independentlyParsed);
      expect(
        json.components.schemas.ApiWaveParticipationSubmissionStrategy
          .properties.config.$ref
      ).toBe(
        '#/components/schemas/ApiWaveParticipationSubmissionStrategyIdentityConf'
      );
    });
  });
});
