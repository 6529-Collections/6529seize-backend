import { UnsupportedXmlCharacter, xml } from './xml';
import { compileDossier } from './dossier';
import { dossierFixture } from './dossier-fixture';

it('preserves valid Unicode and XML escaping without silently replacing lone surrogates', () => {
  expect(xml('A & <gate> 🗝️\n')).toBe('A &amp; &lt;gate&gt; 🗝️\n');
  for (const invalid of ['\u0000', '\ud800', '\udfff', '\ufffe']) {
    expect(() => xml(invalid)).toThrow(UnsupportedXmlCharacter);
  }
});

it('keeps unsupported XML writing in the complete JSON and reports the omitted projection', () => {
  const { snapshot } = dossierFixture();
  snapshot.context.modules.artwork.title.value =
    'Title with\u0000a retained control';
  const result = compileDossier(snapshot);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'XML_SOURCE_CHARACTER_UNSUPPORTED' })
  );
  expect(
    result.files
      .find((file) => file.path === 'data/record.json')!
      .bytes.toString()
  ).toContain('Title with\\u0000a retained control');
});
