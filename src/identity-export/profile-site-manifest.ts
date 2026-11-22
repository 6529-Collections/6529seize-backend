/** The manifest a profile site export run writes (dbDumpsDaily's job). */
export const PROFILE_SITE_MANIFEST_SCHEMA =
  '6529.profile-site-export.manifest.v1';
/** The file of a profile site run that the identity export takes. */
export const PROFILE_SITE_CMS_FILE = 'cms-fields.json';

/**
 * Why a profile site run's manifest doesn't vouch for the cms fields file,
 * or null. It must list cms-fields.json once, with the file's sha256. At
 * the freeze it must also be a whole, usable run of that very freeze
 * (manifest.json: not a rehearsal, one profile, or a run missing a stored
 * record), and of the stage when one is given.
 */
export function profileSiteManifestProblem(
  manifestText: string,
  cmsSha256: string,
  freezeMs: number | null,
  stage: string | null = null
): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return 'the profile site manifest is not JSON';
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return 'the profile site manifest is not a JSON object';
  }
  const doc = manifest as Record<string, unknown>;
  if (doc.schema !== PROFILE_SITE_MANIFEST_SCHEMA) {
    return `the profile site manifest's schema is ${JSON.stringify(doc.schema ?? null)}, not ${PROFILE_SITE_MANIFEST_SCHEMA}`;
  }
  if (freezeMs !== null) {
    const freeze = new Date(freezeMs).toISOString();
    if (doc.usable !== true || doc.rehearsal === true) {
      return 'the profile site manifest is not of a whole, usable run (usable true, not a rehearsal): the import takes only such a run';
    }
    if (doc.frozen_at !== freeze) {
      return `the profile site run exported the freeze ${JSON.stringify(doc.frozen_at ?? null)}, not ${freeze}`;
    }
  }
  if (stage !== null && doc.stage !== stage) {
    return `the profile site run is of the stage ${JSON.stringify(doc.stage ?? null)}, not ${stage}`;
  }
  const files = Array.isArray(doc.files) ? doc.files : [];
  const listed = files.filter(
    (file) =>
      !!file &&
      typeof file === 'object' &&
      (file as { name?: unknown }).name === PROFILE_SITE_CMS_FILE
  ) as { sha256?: unknown }[];
  if (listed.length !== 1) {
    return `the profile site manifest lists ${PROFILE_SITE_CMS_FILE} ${listed.length} times, not once`;
  }
  if (listed[0].sha256 !== cmsSha256) {
    return `the profile site manifest lists ${PROFILE_SITE_CMS_FILE} with sha256 ${String(listed[0].sha256)}, not the file's ${cmsSha256}`;
  }
  return null;
}
