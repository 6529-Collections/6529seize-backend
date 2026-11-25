import { isCmsCid } from '@/profile-cms/chain/profile-cms-cid';

/**
 * The profile site in a person's ProfileDoc (ProfileDoc.v1). A document's
 * fields are string keys with string values, so the site is three flat keys,
 * each a raw sha2-256 CIDv1 in base32 (`bafkrei...`):
 *
 *   cms.primary.publication  the signed publication record
 *   cms.primary.package      the content core it signs
 *   cms.archive              the person's 6529.io site history at the
 *                            identity freeze (set only by the import)
 *
 * Publication and package come together or not at all; without them the
 * profile serves no site.
 */
export const PROFILE_DOC_CMS_KEYS = {
  publication: 'cms.primary.publication',
  package: 'cms.primary.package',
  archive: 'cms.archive'
} as const;

export interface ProfileDocCmsPrimary {
  readonly publication: string;
  readonly package: string;
}

export interface ProfileDocCms {
  readonly primary: ProfileDocCmsPrimary | null;
  readonly archive: string | null;
}

export type ProfileDocCmsReadResult =
  | { readonly ok: true; readonly cms: ProfileDocCms | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the profile site from a ProfileDoc's fields, as the identity mirror's
 * decoder returns them (key to value). Other keys, `cms.*` ones included,
 * are ignored. A site key that is present but broken refuses the site; a
 * broken archive value reads as no archive (the index takes the archive
 * only from the import's own document, which the snapshot builder checks).
 */
export function readProfileDocCms(
  fields: Readonly<Record<string, string>>
): ProfileDocCmsReadResult {
  const publication = field(fields, PROFILE_DOC_CMS_KEYS.publication);
  const pkg = field(fields, PROFILE_DOC_CMS_KEYS.package);
  const archiveValue = field(fields, PROFILE_DOC_CMS_KEYS.archive);
  const archive = isCmsCid(archiveValue) ? archiveValue : null;
  if (publication === undefined && pkg === undefined) {
    return { ok: true, cms: archive ? { primary: null, archive } : null };
  }
  if (publication === undefined || pkg === undefined) {
    return { ok: false, reason: 'cms_primary_incomplete' };
  }
  if (!isCmsCid(publication) || !isCmsCid(pkg)) {
    return { ok: false, reason: 'cms_primary_invalid' };
  }
  return { ok: true, cms: { primary: { publication, package: pkg }, archive } };
}

/** The document fields that name a site and archive (no key for an absent value). */
export function profileDocCmsFields(
  cms: ProfileDocCms
): Record<string, string> {
  return {
    ...(cms.archive ? { [PROFILE_DOC_CMS_KEYS.archive]: cms.archive } : {}),
    ...(cms.primary
      ? {
          [PROFILE_DOC_CMS_KEYS.package]: cms.primary.package,
          [PROFILE_DOC_CMS_KEYS.publication]: cms.primary.publication
        }
      : {})
  };
}

function field(
  fields: Readonly<Record<string, string>>,
  key: string
): string | undefined {
  return Object.prototype.hasOwnProperty.call(fields, key)
    ? fields[key]
    : undefined;
}
