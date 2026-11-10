import * as fs from 'fs';
import * as yaml from 'js-yaml';

export interface LoadedOpenApiSpec {
  /** The checked-in YAML text, byte for byte. Served at /openapi.yaml. */
  readonly raw: string;
  /** The parsed document. Served at /openapi.json and fed to Swagger UI. */
  readonly document: Record<string, unknown>;
}

/**
 * Parses an OpenAPI document with a YAML 1.2 compliant parser.
 *
 * The production API used `yamljs` for this, which mis-parses two constructs
 * that the checked-in `openapi.yaml` relies on: a folded block scalar whose
 * text starts with `#` (every `$ref` that `restructure-openapi` wraps onto its
 * own line) became an empty string, and any quoted string starting with `0x`
 * (hex patterns and descriptions) became a number. `js-yaml` is the parser
 * that `restructure-openapi.ts` already uses to rewrite the file, so loading
 * with it keeps the served document identical to the committed source.
 */
export function parseOpenApiDocument(
  raw: string,
  filename = 'openapi.yaml'
): Record<string, unknown> {
  const parsed = yaml.load(raw, { filename });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filename} did not parse to an OpenAPI document object`);
  }
  return parsed as Record<string, unknown>;
}

export function loadOpenApiSpec(path = 'openapi.yaml'): LoadedOpenApiSpec {
  const raw = fs.readFileSync(path, 'utf8');
  return { raw, document: parseOpenApiDocument(raw, path) };
}
