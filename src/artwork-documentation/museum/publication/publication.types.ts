import { DossierIssue, DossierSnapshot } from '../export/dossier.types';
import { IiifResource } from '../export/iiif-resources';

/** Bump when the compiled manifest shape changes for identical input. */
export const PUBLICATION_COMPILER_VERSION = 'museum-publication-1.0.0';

export const RESOURCE_ROLES = [
  'authorized_manifestation',
  'documentation_surrogate',
  'preservation_master',
  'access_derivative',
  'live_upstream_service',
  'technical_model'
] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];

export const RESOURCE_ROLE_LABELS: Record<ResourceRole, string> = {
  authorized_manifestation: 'Authorized manifestation',
  documentation_surrogate: 'Documentation surrogate (not the complete work)',
  preservation_master: 'Preservation master',
  access_derivative: 'Access derivative',
  live_upstream_service: 'Live upstream service (mutable)',
  technical_model: 'Technical model'
};

export interface PublicationBindings {
  /** https base under an approved namespace, e.g. https://6529.io/iiif/objects/<object-id> */
  base_url: string;
  /** Stable public https URL per selected asset id. */
  media: Record<string, string>;
  /** Optional https page for the object; defaults to base_url. */
  homepage_url?: string;
}

export interface PublicationRights {
  /** A canonical URI from the museum rights registry (http or https form). */
  rights_uri: string;
  required_statement: { label: string; value: string };
  provider?: { id: string; label: string };
}

export interface PublicationInput {
  snapshot: DossierSnapshot;
  source_sha256: string;
  selection: { asset_ids: string[] };
  bindings: PublicationBindings;
  rights: PublicationRights;
  roles: Record<string, ResourceRole>;
  compiler_version: string;
  /** Optional caller-supplied timestamp; the compiler never reads the clock. */
  produced_at?: string;
}

export interface PublicationValidationError {
  path: string;
  code: string;
  message: string;
}
export interface PublicationValidation {
  ok: boolean;
  errors: PublicationValidationError[];
}

export interface CompiledPublication {
  manifest: IiifResource;
  source_sha256: string;
  manifest_sha256: string;
  transformation: {
    compiler_version: string;
    input_digest: string;
    produced_at?: string;
    issues: DossierIssue[];
  };
  validation: PublicationValidation;
}

export const PUBLICATION_REJECTION_CODES = [
  'UNSUPPORTED_COMPILER_VERSION',
  'SOURCE_HASH_MISMATCH',
  'EMPTY_SELECTION',
  'DUPLICATE_SELECTION',
  'UNKNOWN_ASSET',
  'PRIVATE_ASSET',
  'RIGHTS_EVIDENCE_ASSET',
  'MISSING_ROLE',
  'UNSUPPORTED_ROLE',
  'ROLE_NOT_SELECTED',
  'INCONSISTENT_ROLE',
  'INVALID_BASE_URL',
  'INVALID_HOMEPAGE_URL',
  'MISSING_MEDIA_BINDING',
  'INVALID_MEDIA_URL',
  'BINDING_NOT_SELECTED',
  'RIGHTS_URI_NOT_IN_REGISTRY',
  'ATTRIBUTION_REQUIRED',
  'INVALID_PROVIDER',
  'NO_PRESENTABLE_CANVAS'
] as const;
export type PublicationRejectionCode =
  (typeof PUBLICATION_REJECTION_CODES)[number];

/** Thrown for every input the compiler refuses; structural self-check results are returned instead. */
export class PublicationRejectedError extends Error {
  constructor(
    readonly code: PublicationRejectionCode,
    message: string,
    readonly subject?: string
  ) {
    super(message);
    // The root tsconfig targets es5, where Error subclasses lose their prototype.
    Object.setPrototypeOf(this, PublicationRejectedError.prototype);
    this.name = 'PublicationRejectedError';
  }
}
export function reject(
  code: PublicationRejectionCode,
  message: string,
  subject?: string
): never {
  throw new PublicationRejectedError(code, message, subject);
}
