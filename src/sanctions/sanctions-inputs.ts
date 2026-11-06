import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { sha256Hex } from '@/sanctions/content-address';
import type { SanctionsSourceInputs } from '@/sanctions/sanctions-list-builder';
import {
  SANCTIONS_SOURCE_IDS,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';
import type {
  FetchedSource,
  PinnedDocumentCheck
} from '@/sanctions/sanctions-fetch';
import { compareCodePoints } from '@/sanctions/sanctions-text';

export const SANCTIONS_INPUTS_MANIFEST = 'inputs.json';
export const SANCTIONS_INPUTS_SCHEMA = '6529.sanctions-inputs.v1';

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

export interface SanctionsInputsManifest {
  readonly schema: typeof SANCTIONS_INPUTS_SCHEMA;
  readonly sources: Array<{
    readonly source: SanctionsSourceId;
    readonly files: Array<{
      readonly name: string;
      readonly url: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly fetched_at: string;
    }>;
  }>;
  readonly checks: PinnedDocumentCheck[];
}

function assertSafeName(name: string): void {
  if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`Unsafe input file name ${JSON.stringify(name)}`);
  }
}

function sourceDir(root: string, source: SanctionsSourceId): string {
  if (SANCTIONS_SOURCE_IDS.indexOf(source) === -1) {
    throw new Error(`Unknown sanctions source ${source}`);
  }
  return path.join(root, source);
}

/** Writes fetched files under `<root>/<source>/<name>` plus `inputs.json`. */
export function writeSanctionsInputs(
  root: string,
  fetched: ReadonlyArray<FetchedSource>,
  checks: ReadonlyArray<PinnedDocumentCheck>
): SanctionsInputsManifest {
  const manifest: SanctionsInputsManifest = {
    schema: SANCTIONS_INPUTS_SCHEMA,
    sources: fetched
      .map((source) => {
        const dir = sourceDir(root, source.source);
        mkdirSync(dir, { recursive: true });
        return {
          source: source.source,
          files: source.files.map((file) => {
            assertSafeName(file.name);
            writeFileSync(path.join(dir, file.name), file.bytes);
            return {
              name: file.name,
              url: file.url,
              sha256: sha256Hex(file.bytes),
              bytes: file.bytes.length,
              fetched_at: file.fetched_at
            };
          })
        };
      })
      .sort((a, b) => compareCodePoints(a.source, b.source)),
    checks: checks.slice()
  };
  writeFileSync(
    path.join(root, SANCTIONS_INPUTS_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

/**
 * Reads an inputs directory for the build, refusing any file whose bytes no
 * longer match the sha256 recorded when it was fetched.
 */
export function readSanctionsInputs(root: string): {
  manifest: SanctionsInputsManifest;
  inputs: SanctionsSourceInputs[];
} {
  const manifest = JSON.parse(
    readFileSync(path.join(root, SANCTIONS_INPUTS_MANIFEST), 'utf8')
  ) as SanctionsInputsManifest;
  if (manifest.schema !== SANCTIONS_INPUTS_SCHEMA) {
    throw new Error('Not a sanctions inputs manifest');
  }
  const inputs = manifest.sources.map((source) => ({
    source: source.source,
    files: source.files.map((file) => {
      assertSafeName(file.name);
      const bytes = readFileSync(
        path.join(sourceDir(root, source.source), file.name)
      );
      if (sha256Hex(bytes) !== file.sha256) {
        throw new Error(
          `${source.source}/${file.name} does not match its recorded sha256`
        );
      }
      return { name: file.name, bytes };
    })
  }));
  return { manifest, inputs };
}
