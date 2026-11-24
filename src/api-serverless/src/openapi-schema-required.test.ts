import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const SPEC_PATH = path.resolve(__dirname, '..', 'openapi.yaml');

interface SchemaObject {
  readonly $ref?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly allOf?: readonly SchemaObject[];
  readonly oneOf?: readonly SchemaObject[];
  readonly anyOf?: readonly SchemaObject[];
}

interface OpenApiDocument {
  readonly components: { readonly schemas: Record<string, SchemaObject> };
}

function loadSpec(): OpenApiDocument {
  return yaml.load(fs.readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
}

function deref(spec: OpenApiDocument, schema: SchemaObject): SchemaObject {
  if (!schema.$ref) {
    return schema;
  }
  const prefix = '#/components/schemas/';
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Unsupported $ref ${schema.$ref}`);
  }
  const name = schema.$ref.slice(prefix.length);
  const target = spec.components.schemas[name];
  if (!target) {
    throw new Error(`Dangling $ref ${schema.$ref}`);
  }
  return target;
}

/**
 * Property names a value of this schema can carry: its own `properties` plus
 * those of every `allOf` member (which an instance must also satisfy). The
 * members of `oneOf`/`anyOf` are included too, because a `required` name on
 * the composed schema may legitimately be declared by one of the branches.
 */
function declaredPropertyNames(
  spec: OpenApiDocument,
  schema: SchemaObject,
  seen: Set<SchemaObject> = new Set()
): Set<string> {
  const resolved = deref(spec, schema);
  const names = new Set<string>();
  if (seen.has(resolved)) {
    return names;
  }
  seen.add(resolved);
  for (const name of Object.keys(resolved.properties ?? {})) {
    names.add(name);
  }
  for (const branch of [
    ...(resolved.allOf ?? []),
    ...(resolved.oneOf ?? []),
    ...(resolved.anyOf ?? [])
  ]) {
    declaredPropertyNames(spec, branch, seen).forEach((name) =>
      names.add(name)
    );
  }
  return names;
}

describe('openapi.yaml component schemas', () => {
  const spec = loadSpec();

  it('only mark declared properties as required', () => {
    const violations: string[] = [];
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (!schema.required) {
        continue;
      }
      const declared = declaredPropertyNames(spec, schema);
      for (const requiredName of schema.required) {
        if (!declared.has(requiredName)) {
          violations.push(
            `${name}.required includes undeclared "${requiredName}"`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('describe ApiCreateDropRequest.drop_type as optional with a CHAT default', () => {
    const schema = spec.components.schemas.ApiCreateDropRequest;
    expect(schema.required).toEqual(['wave_id']);
    expect(Object.keys(schema.properties ?? {})).toContain('drop_type');
    const dropType = (schema.properties ?? {}).drop_type as {
      description?: string;
    };
    expect(dropType.description).toMatch(/Defaults to CHAT/);
  });
});
