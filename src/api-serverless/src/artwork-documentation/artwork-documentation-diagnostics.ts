import { PROFILES } from '@/artwork-documentation/artwork-documentation.catalogue';
import {
  MODULE_IDS,
  ModuleId
} from '@/artwork-documentation/artwork-documentation.types';
import { documentationValidationField } from '@/artwork-documentation/artwork-documentation.validation';
import { ApiCompliantException } from '@/exceptions';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';

const logger = Logger.get('ARTWORK_DOCUMENTATION_VALIDATION');
const fieldsByModule = new Map(
  MODULE_IDS.map((id) => [
    id,
    new Set(
      PROFILES.flatMap((profile) =>
        profile.modules
          .filter((module) => module.id === id)
          .flatMap((module) => module.fields.map((field) => field.id))
      )
    )
  ])
);
// Never export arbitrary exception codes: dependencies can attach dynamic text.
const validationCodes = new Set([
  'INVALID_REQUEST',
  'INVALID_MODULE',
  'INVALID_VERSION',
  'UNSUPPORTED_SCHEMA',
  'INVALID_OPERATIONS',
  'INVALID_FIELD',
  'INVALID_UNICODE',
  'INVALID_ANSWER',
  'INVALID_VALUE',
  'INVALID_DATE',
  'INVALID_ENTRIES',
  'INVALID_TRANSLATIONS',
  'DETAIL_REQUIRED',
  'EXPLANATION_REQUIRED',
  'RESTRICTED_VISIBILITY_REQUIRED',
  'FIELD_NOT_IN_PROFILE',
  'PUBLICATION_INTENT_REQUIRED',
  'PROGRAM_TERMS_FIXED',
  'REPLACEMENT_REASON_REQUIRED',
  'PUBLICATION_RECORD_RESTRICTED',
  'INTERVIEW_DISCLOSURE_MISMATCH',
  'INTERVIEW_PERMISSION_REQUIRED',
  'UNSUPPORTED_INTERVIEW_INSTRUMENT',
  'ASSET_ROLE_REQUIRED',
  'MASTER_ASSET_REQUIRED',
  'MASTER_ROLE_REQUIRED',
  'SOURCE_ASSET_REQUIRED',
  'DUPLICATE_MUSEUM_ID',
  'DURATION_REQUIRED',
  'INCOMPLETE_COORDINATES',
  'INVALID_ENTRY_DOCUMENT',
  'INVALID_TGN_IDENTITY',
  'INVALID_TIME_RANGE',
  'MEASUREMENT_NOTE_REQUIRED',
  'PRESENTATION_REGION_OUT_OF_BOUNDS',
  'PRESENTATION_TIME_OUT_OF_BOUNDS'
]);

type OperationField = { operation: 'set' | 'unset'; field: string };

function knownOperationFields(
  module: ModuleId,
  body: unknown
): OperationField[] {
  if (!body || typeof body !== 'object' || !('operations' in body)) return [];
  if (!Array.isArray(body.operations)) return [];
  const known = fieldsByModule.get(module)!;
  const fields = new Map<string, OperationField>();
  for (const operation of body.operations.slice(0, 100)) {
    if (
      operation &&
      typeof operation === 'object' &&
      (operation.op === 'set' || operation.op === 'unset') &&
      typeof operation.field === 'string' &&
      known.has(operation.field)
    ) {
      const key = `${operation.op}:${operation.field}`;
      fields.set(key, { operation: operation.op, field: operation.field });
    }
  }
  return Array.from(fields.values()).sort(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.operation.localeCompare(right.operation)
  );
}

export function logDocumentationModuleRejection(
  module: unknown,
  body: unknown,
  error: unknown
): void {
  if (
    !MODULE_IDS.includes(module as ModuleId) ||
    !(error instanceof ApiCompliantException) ||
    error.getStatusCode() !== 422
  )
    return;
  try {
    const field = documentationValidationField(error);
    const rejectedField =
      field && fieldsByModule.get(field.module)?.has(field.field)
        ? field
        : undefined;
    const correlation = loggerContext.get()?.requestId;
    const requestId =
      correlation && /^[a-z0-9_-]{1,100}$/i.test(correlation)
        ? correlation
        : undefined;
    // The normal logger also includes jwtSub. Remove it for this entry only.
    loggerContext.run({ requestId }, () =>
      logger.warn({
        event: 'documentation_module_validation_rejected',
        operation: 'patch_module',
        module,
        status: 422,
        code:
          error.code && validationCodes.has(error.code)
            ? error.code
            : 'VALIDATION_REJECTED',
        operation_fields: knownOperationFields(module as ModuleId, body),
        ...(rejectedField ? { rejected_field: rejectedField } : {})
      })
    );
  } catch {
    // Diagnostics must never replace the original validation failure.
  }
}
