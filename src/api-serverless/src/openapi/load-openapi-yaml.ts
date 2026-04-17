import * as fs from 'node:fs';
import * as path from 'node:path';
import * as jsYaml from 'js-yaml';
import * as SwaggerUI from 'swagger-ui-express';

export function loadOpenApiYaml(
  baseDir: string,
  fileName: string,
  candidateRelativePaths: string[]
): NonNullable<Parameters<typeof SwaggerUI.setup>[0]> {
  const candidates = candidateRelativePaths.map((relativePath) =>
    path.join(baseDir, relativePath, fileName)
  );
  const yamlPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!yamlPath) {
    throw new Error(`${fileName} not found. Tried: ${candidates.join(', ')}`);
  }

  return jsYaml.load(fs.readFileSync(yamlPath, 'utf8')) as NonNullable<
    Parameters<typeof SwaggerUI.setup>[0]
  >;
}
