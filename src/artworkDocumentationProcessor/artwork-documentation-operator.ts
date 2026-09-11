import { randomUUID } from 'node:crypto';
import type { LambdaSentryEvent } from '@/sentry.context';
import { AuthenticationContext } from '@/auth-context';
import { PROFILES_TABLE } from '@/constants';
import { ArtworkDocumentationService } from '@/artwork-documentation/artwork-documentation.service';
import { artworkDocumentationDb } from '@/artwork-documentation/artwork-documentation.db';
import { importKeysAndGates } from '@/artwork-documentation/artwork-documentation-pilot';
import { AD_EVENTS } from '@/artwork-documentation/artwork-documentation.tables';
import { fail } from '@/artwork-documentation/artwork-documentation.validation';
import { KeysAndGatesSourceDropsMissingError } from '@/artwork-documentation/artwork-documentation-import.errors';
import { setKeysAndGatesCoordinatorReadAccess } from '@/artwork-documentation/artwork-documentation-coordinator-access';
import { upgradeEmptyKeysAndGatesPublication } from '@/artwork-documentation/artwork-documentation-publication-upgrade';
import {
  parseProgramViewersEvent,
  ProgramViewersEvent,
  setProgramViewers
} from '@/artwork-documentation/artwork-documentation-program-viewer-operator';

export type DocumentationOperatorEvent =
  | ProgramViewersEvent
  | {
      operator_action:
        | 'import_keys_and_gates_v1'
        | 'set_keys_and_gates_coordinator_read_access_v1'
        | 'upgrade_empty_keys_and_gates_publication_v2';
      correlation_id: string;
      coordinator_profile_id: string;
      apply: boolean;
    }
  | { operator_action: 'create_smoke_context_v1'; correlation_id: string };
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

export function parseDocumentationOperatorEvent(
  event: unknown
): DocumentationOperatorEvent | null {
  if (
    !event ||
    typeof event !== 'object' ||
    !Object.prototype.hasOwnProperty.call(event, 'operator_action')
  )
    return null;
  const input = event as Record<string, unknown>;
  if (!isUuid(input.correlation_id)) fail(422, 'INVALID_OPERATOR_REQUEST');
  if (input.operator_action === 'set_program_viewers_v1')
    return parseProgramViewersEvent(input);
  const common = ['operator_action', 'correlation_id'];
  if (input.operator_action === 'create_smoke_context_v1') {
    if (Object.keys(input).some((key) => !common.includes(key)))
      fail(422, 'INVALID_OPERATOR_REQUEST');
    return {
      operator_action: input.operator_action,
      correlation_id: input.correlation_id
    };
  }
  if (
    ![
      'import_keys_and_gates_v1',
      'set_keys_and_gates_coordinator_read_access_v1',
      'upgrade_empty_keys_and_gates_publication_v2'
    ].includes(input.operator_action as string) ||
    !isUuid(input.coordinator_profile_id)
  )
    fail(422, 'INVALID_OPERATOR_REQUEST');
  if (
    (input.apply !== undefined && typeof input.apply !== 'boolean') ||
    Object.keys(input).some(
      (key) => ![...common, 'coordinator_profile_id', 'apply'].includes(key)
    )
  )
    fail(422, 'INVALID_OPERATOR_REQUEST');
  return {
    operator_action: input.operator_action as
      | 'import_keys_and_gates_v1'
      | 'set_keys_and_gates_coordinator_read_access_v1'
      | 'upgrade_empty_keys_and_gates_publication_v2',
    correlation_id: input.correlation_id,
    coordinator_profile_id: input.coordinator_profile_id,
    apply: input.apply === true
  };
}

/** Called only from the IAM-invoked processor, never registered on the API. */
export async function runDocumentationOperator(
  event: DocumentationOperatorEvent
) {
  const service = new ArtworkDocumentationService(
    artworkDocumentationDb,
    undefined,
    {
      enabled: () => true,
      selfServiceEnabled: () =>
        event.operator_action === 'create_smoke_context_v1'
    }
  );
  if (event.operator_action === 'set_program_viewers_v1')
    return setProgramViewers(event, service);
  if (event.operator_action === 'set_keys_and_gates_coordinator_read_access_v1')
    return setKeysAndGatesCoordinatorReadAccess(event, service);
  if (event.operator_action === 'upgrade_empty_keys_and_gates_publication_v2')
    return upgradeEmptyKeysAndGatesPublication(event, service);
  if (event.operator_action === 'import_keys_and_gates_v1') {
    const result = await importKeysAndGates(
      event.coordinator_profile_id,
      event.apply,
      service,
      event.correlation_id
    );
    if (event.apply)
      await recordOperatorAction(service, event, event.coordinator_profile_id);
    return { correlation_id: event.correlation_id, ...result };
  }
  const profile = await service.db.one<{ external_id: string }>(
    `SELECT external_id FROM ${PROFILES_TABLE} WHERE normalised_handle=:handle LIMIT 1`,
    { handle: 'punk6529bot' },
    {}
  );
  if (!profile) fail(422, 'SMOKE_PROFILE_NOT_FOUND');
  const ctx = {
    authenticationContext: AuthenticationContext.fromProfileId(
      profile.external_id
    )
  };
  const body = {
    profile_id: 'stream_artwork_basic_v1',
    profile_version: 1,
    start_mode: 'standalone'
  };
  const context = await service.createWork(
    body,
    {
      route: 'operator:create_smoke_context_v1',
      key: event.correlation_id,
      body
    },
    ctx
  );
  await recordOperatorAction(service, event, profile.external_id, context.id);
  return {
    correlation_id: event.correlation_id,
    work_id: context.work_id,
    context_id: context.id,
    owner_profile_id: profile.external_id
  };
}

async function recordOperatorAction(
  service: ArtworkDocumentationService,
  event: DocumentationOperatorEvent,
  actor: string,
  contextId = '00000000-0000-0000-0000-000000000000'
): Promise<void> {
  await service.db.insert(
    AD_EVENTS,
    {
      id: randomUUID(),
      context_id: contextId,
      actor_profile_id: actor,
      kind: 'iam_operator_action',
      references_json: JSON.stringify({
        action: event.operator_action,
        correlation_id: event.correlation_id
      }),
      created_at: Date.now()
    },
    {}
  );
}

export async function dispatchDocumentationProcessorEvent(
  event: unknown,
  tick: () => Promise<void>,
  operator: (
    event: DocumentationOperatorEvent
  ) => Promise<unknown> = runDocumentationOperator
): Promise<unknown> {
  const action = parseDocumentationOperatorEvent(event);
  if (action) return operator(action);
  await tick();
  return undefined;
}

export function enrichDocumentationOperatorError(
  event: LambdaSentryEvent,
  error: unknown
): LambdaSentryEvent {
  if (!(error instanceof KeysAndGatesSourceDropsMissingError)) return event;
  return {
    ...event,
    fingerprint: [error.code],
    tags: {
      ...event.tags,
      error_code: error.code,
      operator_action: 'import_keys_and_gates_v1',
      import_mode: error.mode
    },
    contexts: {
      ...event.contexts,
      artwork_documentation_import: {
        error_code: error.code,
        missing_drop_ids: error.missingDropIds,
        mode: error.mode,
        correlation_id: error.correlationId
      }
    }
  };
}
