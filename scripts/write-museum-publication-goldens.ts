import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PUBLICATION_CASES,
  publicationFixture
} from '../src/artwork-documentation/museum/fixtures/publication-fixtures';
import { compilePublication } from '../src/artwork-documentation/museum/publication/publication-compiler';

// Regenerates the committed publication goldens after an intentional compiler
// change. It writes only the fixed fixture directory inside the repository.
const output = join(
  realpathSync(resolve(__dirname, '..')),
  'src/artwork-documentation/museum/fixtures/publication'
);
mkdirSync(output, { recursive: true });
const digests: Record<string, Record<string, string>> = {};
for (const name of PUBLICATION_CASES) {
  const compiled = compilePublication(publicationFixture(name).input);
  if (!compiled.validation.ok)
    throw new Error(`${name}: ${JSON.stringify(compiled.validation.errors)}`);
  writeFileSync(
    join(output, `${name}.json`),
    JSON.stringify(compiled.manifest, null, 2) + '\n',
    'utf8'
  );
  digests[name] = {
    source_sha256: compiled.source_sha256,
    manifest_sha256: compiled.manifest_sha256,
    input_digest: compiled.transformation.input_digest
  };
}
writeFileSync(
  join(output, 'digests.json'),
  JSON.stringify(digests, null, 2) + '\n',
  'utf8'
);
process.stdout.write(
  `Wrote ${PUBLICATION_CASES.length} publication goldens to ${output}\n`
);
