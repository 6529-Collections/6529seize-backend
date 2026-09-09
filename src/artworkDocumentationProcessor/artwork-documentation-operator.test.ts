import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { ArtworkDocumentationService } from '@/artwork-documentation/artwork-documentation.service';
import { artworkDocumentationDb } from '@/artwork-documentation/artwork-documentation.db';
import { importKeysAndGates } from '@/artwork-documentation/artwork-documentation-pilot';
import {
  dispatchDocumentationProcessorEvent,
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
