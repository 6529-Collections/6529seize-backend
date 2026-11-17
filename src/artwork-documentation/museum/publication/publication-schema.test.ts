// ajv 6 is resolved from the repository toolchain (eslint's dependency tree); it
// is used here only as the JSON Schema draft-07 oracle for the pinned upstream
// IIIF Presentation 3 schema that the Python validators also check.
import Ajv from 'ajv';
import schema from '../export/schemas/iiif-presentation-3.json';
import {
  PUBLICATION_CASES,
  publicationFixture
} from '../fixtures/publication-fixtures';
import { compilePublication } from './publication-compiler';

describe('Compiled publication manifests against the pinned IIIF Presentation 3 schema', () => {
  const ajv = new Ajv({ format: 'full', allErrors: true });
  const validate = ajv.compile(schema);
  it.each(PUBLICATION_CASES)('%s validates', (name) => {
    const { input } = publicationFixture(name);
    const compiled = compilePublication(input);
    const ok = validate(compiled.manifest);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
  it('rejects the https rights form the registry records, which is why the compiler emits http', () => {
    const { input } = publicationFixture('still-image');
    const { manifest } = compilePublication(input);
    expect(validate({ ...manifest, rights: input.rights.rights_uri })).toBe(
      false
    );
  });
});
