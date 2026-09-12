import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileDossier } from '../src/artwork-documentation/museum/export/dossier';
import { dossierFixture } from '../src/artwork-documentation/museum/export/dossier-fixture';
import { wrapDossierInOcfl, OCFL_BAG_PREFIX } from '../src/artwork-documentation/museum/export/ocfl';

const destination = resolve(process.argv[2] ?? '.artwork-dossier-fixture');
const { snapshot, original } = dossierFixture();
const dossier = compileDossier(snapshot);
const ocfl = wrapDossierInOcfl(snapshot, dossier);
for (const file of ocfl.files) {
  const path = join(destination, file.path);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, file.bytes);
}
for (const file of dossier.manifest.filter((file) => 'asset_id' in file)) {
  const path = join(destination, OCFL_BAG_PREFIX, file.path);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, original);
}
process.stdout.write(`Wrote synthetic standards fixture to ${destination}\n`);
