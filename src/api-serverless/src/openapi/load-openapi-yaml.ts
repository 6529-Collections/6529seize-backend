import * as fs from 'node:fs';
import * as path from 'node:path';
import * as jsYaml from 'js-yaml';
import * as SwaggerUI from 'swagger-ui-express';

type SwaggerDocument = NonNullable<Parameters<typeof SwaggerUI.setup>[0]>;

function isSwaggerDocument(value: unknown): value is SwaggerDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadOpenApiYaml(
  baseDir: string,
  fileName: string,
  candidateRelativePaths: string[]
): SwaggerDocument {
  const candidates = candidateRelativePaths.map((relativePath) =>
    path.join(baseDir, relativePath, fileName)
  );
  const yamlPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!yamlPath) {
    throw new Error(`${fileName} not found. Tried: ${candidates.join(', ')}`);
  }

  const document = jsYaml.load(fs.readFileSync(yamlPath, 'utf8'));

  if (!isSwaggerDocument(document)) {
    throw new Error(`${fileName} did not parse to a Swagger document object.`);
  }

  return document;
}
