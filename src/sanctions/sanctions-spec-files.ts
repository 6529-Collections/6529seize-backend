import { readFileSync } from 'fs';
import * as path from 'path';

/** Location of the shared spec, vectors and fixtures (`specs/sanctions-list-v1`). */
export const SANCTIONS_SPEC_DIR = path.join(
  __dirname,
  '..',
  '..',
  'specs',
  'sanctions-list-v1'
);

export function readSanctionsVector<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(SANCTIONS_SPEC_DIR, 'vectors', name), 'utf8')
  ) as T;
}
