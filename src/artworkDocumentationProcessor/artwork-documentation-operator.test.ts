import { randomUUID } from 'node:crypto';
import type { LambdaSentryEvent } from '@/sentry.context';
import { AuthenticationContext } from '@/auth-context';
import { ArtworkDocumentationService } from '@/artwork-documentation/artwork-documentation.service';
import { artworkDocumentationDb } from '@/artwork-documentation/artwork-documentation.db';
import { importKeysAndGates } from '@/artwork-documentation/artwork-documentation-pilot';
import { KeysAndGatesSourceDropsMissingError } from '@/artwork-documentation/artwork-documentation-import.errors';
import {
  dispatchDocumentationProcessorEvent,
  enrichDocumentationOperatorError,
  parseDocumentationOperatorEvent,
  runDocumentationOperator
} from './artwork-documentation-operator';

jest.mock('@/artwork-documentation/artwork-documentation-pilot', () => ({
  importKeysAndGates: jest.fn()
}));
const originalEnabled = process.env.ARTWORK_DOCUMENTATION_ENABLED;
const originalSelfService =
  process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED;
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (originalEnabled === undefined)
    delete process.env.ARTWORK_DOCUMENTATION_ENABLED;
  else process.env.ARTWORK_DOCUMENTATION_ENABLED = originalEnabled;
  if (originalSelfService === undefined)
    delete process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED;
  else
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED =
      originalSelfService;
});

describe('IAM-only artwork documentation operator', () => {
  it('accepts explicit program viewer subjects only and requires a reviewed inventory for application', () => {
    const event = {
      operator_action: 'set_program_viewers_v1',
      correlation_id: randomUUID(),
      coordinator_profile_id: randomUUID(),
      program_id: '6529NM-AP-01',
      viewers: { profiles: [randomUUID()], groups: ['existing-team-group'] }
    };
    expect(parseDocumentationOperatorEvent(event)).toEqual({
      ...event,
      apply: false
    });
    expect(
      parseDocumentationOperatorEvent({
        ...event,
        apply: true,
        expected_inventory_sha256: 'a'.repeat(64)
      })
    ).toMatchObject({ apply: true });
    for (const invalid of [
      { ...event, apply: true },
      { ...event, capabilities: { manage_context: true } },
      { ...event, program_id: 'unknown-program' },
      { ...event, viewers: { profiles: ['not-a-profile'], groups: [] } },
      { ...event, viewers: { profiles: [], groups: ['group with spaces'] } },
      { ...event, viewers: { profiles: [], groups: ['same', 'same'] } },
      { ...event, viewers: { profiles: [], groups: [], all: true } },
      { ...event, expected_inventory_sha256: 'bad' }
    ])
      expect(() => parseDocumentationOperatorEvent(invalid)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPERATOR_REQUEST' })
      );
  });
  it('preserves ordinary scheduled processing', async () => {
    const tick = jest.fn(async () => undefined);
    const operator = jest.fn();
    await dispatchDocumentationProcessorEvent(
      { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} },
      tick,
      operator
    );
    expect(tick).toHaveBeenCalledTimes(1);
    expect(operator).not.toHaveBeenCalled();
  });
  it('dispatches only the closed operator action and defaults imports to dry-run', async () => {
    const event = {
      operator_action: 'import_keys_and_gates_v1',
      correlation_id: randomUUID(),
      coordinator_profile_id: randomUUID()
    };
    const tick = jest.fn();
    const operator = jest.fn(async () => ({ count: 16 }));
    expect(
      await dispatchDocumentationProcessorEvent(event, tick, operator)
    ).toEqual({ count: 16 });
    expect(operator).toHaveBeenCalledWith({ ...event, apply: false });
    expect(tick).not.toHaveBeenCalled();
  });
  it.each([
    'set_keys_and_gates_coordinator_read_access_v1',
    'upgrade_empty_keys_and_gates_publication_v2'
  ])(
    'defaults %s to dry-run and rejects caller-supplied scope or capabilities',
    (action) => {
      const event = {
        operator_action: action,
        correlation_id: randomUUID(),
        coordinator_profile_id: randomUUID()
      };
      expect(parseDocumentationOperatorEvent(event)).toEqual({
        ...event,
        apply: false
      });
      for (const extra of [
        { program_id: 'another-program' },
        { capabilities: { confirm_as_artist: true } },
        { context_ids: [] },
        { apply: 'true' }
      ])
        expect(() =>
          parseDocumentationOperatorEvent({ ...event, ...extra })
        ).toThrow(
          expect.objectContaining({ code: 'INVALID_OPERATOR_REQUEST' })
        );
    }
  );
  it.each([
    { operator_action: 'arbitrary_sql', correlation_id: randomUUID() },
    {
      operator_action: 'create_smoke_context_v1',
      correlation_id: randomUUID(),
      owner_profile_id: randomUUID()
    },
    {
      operator_action: 'import_keys_and_gates_v1',
      correlation_id: randomUUID(),
      coordinator_profile_id: randomUUID(),
      roster: []
    },
    {
      operator_action: 'import_keys_and_gates_v1',
      correlation_id: randomUUID(),
      coordinator_profile_id: randomUUID(),
      apply: 'true'
    },
    { operator_action: 'create_smoke_context_v1', correlation_id: 'not-a-uuid' }
  ])('rejects unapproved operator input %#', (input) => {
    expect(() => parseDocumentationOperatorEvent(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATOR_REQUEST' })
    );
  });
  it('enables imports only on the operator service without changing API feature flags', async () => {
    process.env.ARTWORK_DOCUMENTATION_ENABLED = 'false';
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED = 'false';
    const event = {
      operator_action: 'import_keys_and_gates_v1' as const,
      correlation_id: randomUUID(),
      coordinator_profile_id: randomUUID(),
      apply: false
    };
    const insert = jest
      .spyOn(artworkDocumentationDb, 'insert')
      .mockResolvedValue(undefined);
    (importKeysAndGates as jest.Mock).mockImplementation(
      async (_profile, apply, service: ArtworkDocumentationService) => {
        const profile = await service.profiles({
          authenticationContext: AuthenticationContext.fromProfileId(
            event.coordinator_profile_id
          )
        });
        expect(profile).toMatchObject({
          enabled: true,
          self_service_enabled: false
        });
        expect(apply).toBe(false);
        return { mode: 'dry_run', sources: [] };
      }
    );
    await runDocumentationOperator(event);
    expect(importKeysAndGates).toHaveBeenCalledWith(
      event.coordinator_profile_id,
      false,
      expect.any(ArtworkDocumentationService),
      event.correlation_id
    );
    expect(insert).not.toHaveBeenCalled();
    expect(process.env.ARTWORK_DOCUMENTATION_ENABLED).toBe('false');
    expect(process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED).toBe(
      'false'
    );
    expect(await new ArtworkDocumentationService().profiles({})).toEqual({
      enabled: false,
      self_service_enabled: false,
      profiles: []
    });
  });
  it('creates only an empty bot-owned nonprogram context and records correlation', async () => {
    process.env.ARTWORK_DOCUMENTATION_ENABLED = 'false';
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED = 'false';
    const owner = randomUUID();
    const id = randomUUID();
    const workId = randomUUID();
    const event = {
      operator_action: 'create_smoke_context_v1' as const,
      correlation_id: randomUUID()
    };
    const lookup = jest
      .spyOn(artworkDocumentationDb, 'one')
      .mockResolvedValue({ external_id: owner });
    const insert = jest
      .spyOn(artworkDocumentationDb, 'insert')
      .mockResolvedValue(undefined);
    const create = jest
      .spyOn(ArtworkDocumentationService.prototype, 'createWork')
      .mockResolvedValue({ id, work_id: workId } as Awaited<
        ReturnType<ArtworkDocumentationService['createWork']>
      >);
    expect(await runDocumentationOperator(event)).toEqual({
      correlation_id: event.correlation_id,
      work_id: workId,
      context_id: id,
      owner_profile_id: owner
    });
    expect(lookup).toHaveBeenCalledWith(
      expect.stringContaining('normalised_handle=:handle'),
      { handle: 'punk6529bot' },
      {}
    );
    expect(create).toHaveBeenCalledWith(
      {
        profile_id: 'stream_artwork_basic_v1',
        profile_version: 1,
        start_mode: 'standalone'
      },
      expect.objectContaining({ key: event.correlation_id }),
      expect.objectContaining({
        authenticationContext: expect.objectContaining({
          authenticatedProfileId: owner
        })
      })
    );
    expect(insert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        context_id: id,
        references_json: JSON.stringify({
          action: event.operator_action,
          correlation_id: event.correlation_id
        })
      }),
      {}
    );
    expect(importKeysAndGates).not.toHaveBeenCalled();
    expect(process.env.ARTWORK_DOCUMENTATION_ENABLED).toBe('false');
  });
  it('fails closed if the existing punk6529bot identity is absent', async () => {
    jest.spyOn(artworkDocumentationDb, 'one').mockResolvedValue(null);
    const create = jest.spyOn(
      ArtworkDocumentationService.prototype,
      'createWork'
    );
    await expect(
      runDocumentationOperator({
        operator_action: 'create_smoke_context_v1',
        correlation_id: randomUUID()
      })
    ).rejects.toMatchObject({ code: 'SMOKE_PROFILE_NOT_FOUND' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('operator Sentry diagnostics', () => {
  it.each([false, true])(
    'enriches missing-source errors with apply=%s',
    (apply) => {
      const missing = [randomUUID(), randomUUID()];
      const correlationId = randomUUID();
      const error = new KeysAndGatesSourceDropsMissingError(
        missing,
        apply,
        correlationId
      );
      const event: LambdaSentryEvent = {
        tags: { environment: 'staging' },
        contexts: { runtime: { name: 'node' } },
        exception: {
          values: [
            {
              type: error.name,
              value: error.message,
              mechanism: { type: 'generic', handled: false }
            }
          ]
        }
      };
      const enriched = enrichDocumentationOperatorError(event, error);
      expect(enriched).toEqual({
        ...event,
        fingerprint: ['KEYS_AND_GATES_SOURCE_DROPS_MISSING'],
        tags: {
          ...event.tags,
          error_code: error.code,
          operator_action: 'import_keys_and_gates_v1',
          import_mode: apply ? 'apply' : 'dry_run'
        },
        contexts: {
          ...event.contexts,
          artwork_documentation_import: {
            error_code: error.code,
            missing_drop_ids: missing,
            mode: apply ? 'apply' : 'dry_run',
            correlation_id: correlationId
          }
        }
      });
      expect(enriched.exception).toBe(event.exception);
      expect(event.contexts).not.toHaveProperty('artwork_documentation_import');
      const unrelated: LambdaSentryEvent = {
        message: 'A subsequent scheduled worker error'
      };
      expect(
        enrichDocumentationOperatorError(unrelated, new Error('Worker failed'))
      ).toBe(unrelated);
    }
  );

  it('keeps a failed import rejected and does not record a successful operator action', async () => {
    const error = new KeysAndGatesSourceDropsMissingError(
      [randomUUID()],
      true,
      randomUUID()
    );
    (importKeysAndGates as jest.Mock).mockRejectedValue(error);
    const insert = jest.spyOn(artworkDocumentationDb, 'insert');
    await expect(
      runDocumentationOperator({
        operator_action: 'import_keys_and_gates_v1',
        coordinator_profile_id: randomUUID(),
        correlation_id: randomUUID(),
        apply: true
      })
    ).rejects.toBe(error);
    expect(insert).not.toHaveBeenCalled();
  });
});
