import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  CAPTURE_CASES,
  alterationCorpus,
  mediaCorpus
} from '../src/artwork-documentation/museum/fixtures/museum-corpus';
import { buildLido } from '../src/artwork-documentation/museum/export/lido';
import { buildPremis } from '../src/artwork-documentation/museum/export/premis';
import { buildLinkedArtExport } from '../src/artwork-documentation/museum/export/linked-art';
import { buildIiif } from '../src/artwork-documentation/museum/export/iiif';
import { DossierSnapshot } from '../src/artwork-documentation/museum/export/dossier.types';
import {
  PUBLICATION_CASES,
  publicationFixture
} from '../src/artwork-documentation/museum/fixtures/publication-fixtures';
import { compilePublication } from '../src/artwork-documentation/museum/publication/publication-compiler';

// This development command writes only its fixed, ignored fixture directory.
// It does not accept an arbitrary filesystem destination from CLI input.
const output = join(
  realpathSync(resolve(__dirname, '..')),
  '.museum-corpus-fixtures'
);
mkdirSync(output, { recursive: true });
if (realpathSync(output) !== output)
  throw new Error('Museum corpus output must not traverse a symbolic link.');
const cases: [string, DossierSnapshot][] = [
  ...CAPTURE_CASES.map((media): [string, DossierSnapshot] => [
    media.join('-'),
    mediaCorpus(media).snapshot
  ]),
  ['an-alteration', alterationCorpus().snapshot]
];
const manifest = cases.map(([name, snapshot]) => {
  const linked = buildLinkedArtExport(
    snapshot.context,
    snapshot.museum_records
  );
  const iiif = buildIiif(
    snapshot.context,
    snapshot.assets,
    `https://example.invalid/corpus/${name}`
  );
  const files = [
    [`${name}-lido.xml`, buildLido(snapshot)],
    [`${name}-premis.xml`, buildPremis(snapshot)],
    [`${name}-mapping.json`, JSON.stringify(linked, null, 2)],
    [`${name}-iiif.json`, JSON.stringify(iiif.manifest, null, 2)],
    [
      `${name}-iiif-mapping.json`,
      JSON.stringify({ bindings: iiif.bindings, issues: iiif.issues }, null, 2)
    ]
  ];
  return {
    name,
    expected_incomplete: name === 'an-alteration',
    files: files.map(([path, content]) => {
      writeFileSync(join(output, path), content, 'utf8');
      return {
        path,
        sha256: createHash('sha256').update(content, 'utf8').digest('hex')
      };
    })
  };
});
// Bound publication manifests: the same compiler output as the committed
// goldens, written here so the independent Python validator checks them
// against the pinned IIIF schema alongside the draft corpus.
const publications = PUBLICATION_CASES.map((name) => {
  const compiled = compilePublication(publicationFixture(name).input);
  if (!compiled.validation.ok)
    throw new Error(`Publication fixture ${name} failed structural validation`);
  const path = `publication-${name}.json`;
  const content = JSON.stringify(compiled.manifest, null, 2);
  writeFileSync(join(output, path), content, 'utf8');
  return {
    name,
    path,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    manifest_sha256: compiled.manifest_sha256,
    source_sha256: compiled.source_sha256
  };
});
writeFileSync(
  join(output, 'corpus-manifest.json'),
  JSON.stringify(
    {
      purpose:
        'Synthetic capture/export verification and exact user-supplied sample preservation; not live upload, scanner, signatures or institutional acceptance evidence.',
      cases: manifest,
      publications
    },
    null,
    2
  ),
  'utf8'
);
process.stdout.write(
  `Wrote ${manifest.length} museum capture/export cases and ${publications.length} publication manifests to ${output}\n`
);
