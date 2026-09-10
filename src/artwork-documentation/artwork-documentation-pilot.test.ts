import { randomUUID } from 'node:crypto';
import { CustomApiCompliantException } from '@/exceptions';
import { ArtworkDocumentationService } from './artwork-documentation.service';
import { KeysAndGatesSourceDropsMissingError } from './artwork-documentation-import.errors';
import {
  importKeysAndGates,
  KEYS_AND_GATES_SOURCE_DROP_IDS
} from './artwork-documentation-pilot';

const coordinator = randomUUID();
const correlationId = randomUUID();
const waveId = '4ff022b3-aa17-4a0a-ba78-58f64ff1d427';
const sourceDrop = (id: string) => ({
  id,
  author_id: randomUUID(),
  wave_id: waveId,
  title: 'Source title must not appear in diagnostics'
});

function setup() {
  const service = new ArtworkDocumentationService();
  const profile = jest
    .spyOn(service.db, 'one')
    .mockResolvedValue({ external_id: coordinator });
  const getDrop = jest
    .spyOn(service, 'getDrop')
    .mockImplementation(async (id) => sourceDrop(id));
  const transaction = jest.spyOn(
    service.db,
    'executeNativeQueriesInTransaction'
  );
  const insert = jest.spyOn(service.db, 'insert');
  const createWork = jest.spyOn(service, 'createWork');
  return { service, profile, getDrop, transaction, insert, createWork };
}

afterEach(() => jest.restoreAllMocks());

describe('Keys and Gates import source validation', () => {
  it.each([false, true])(
    'reports all missing sources before any writes with apply=%s',
    async (apply) => {
      const { service, getDrop, transaction, insert, createWork } = setup();
      const missing = [
        KEYS_AND_GATES_SOURCE_DROP_IDS[0],
        KEYS_AND_GATES_SOURCE_DROP_IDS[7],
        KEYS_AND_GATES_SOURCE_DROP_IDS[15]
      ];
      getDrop.mockImplementation(async (id) => {
        if (missing.some((missingId) => missingId === id))
          throw new CustomApiCompliantException(
            404,
            'artworkDocumentation.errors.UNAVAILABLE',
            'UNAVAILABLE'
          );
        return sourceDrop(id);
      });

      await expect(
        importKeysAndGates(coordinator, apply, service, correlationId)
      ).rejects.toMatchObject({
        name: 'KeysAndGatesSourceDropsMissingError',
        code: 'KEYS_AND_GATES_SOURCE_DROPS_MISSING',
        message:
          'Keys and Gates import aborted: 3 required source drops were not found. No import changes were made.',
        missingDropIds: missing,
        mode: apply ? 'apply' : 'dry_run',
        correlationId
      });
      expect(getDrop.mock.calls.map(([id]) => id)).toEqual(
        KEYS_AND_GATES_SOURCE_DROP_IDS
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(createWork).not.toHaveBeenCalled();
    }
  );

  it('reports an entirely absent roster, including without an operator correlation ID', async () => {
    const { service, getDrop, transaction } = setup();
    getDrop.mockRejectedValue(
      new CustomApiCompliantException(404, 'Unavailable', 'UNAVAILABLE')
    );
    await expect(
      importKeysAndGates(coordinator, false, service)
    ).rejects.toMatchObject({
      name: KeysAndGatesSourceDropsMissingError.name,
      missingDropIds: KEYS_AND_GATES_SOURCE_DROP_IDS,
      mode: 'dry_run'
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Database connection failed'),
    new CustomApiCompliantException(500, 'Unexpected failure', 'UNAVAILABLE'),
    new CustomApiCompliantException(404, 'Other missing resource', 'OTHER')
  ])('preserves unexpected lookup errors: %s', async (error) => {
    const { service, getDrop, transaction } = setup();
    getDrop.mockRejectedValue(error);
    await expect(importKeysAndGates(coordinator, true, service)).rejects.toBe(
      error
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('preserves coordinator validation before source lookups', async () => {
    const { service, profile, getDrop } = setup();
    profile.mockResolvedValue(null);
    await expect(
      importKeysAndGates(coordinator, true, service)
    ).rejects.toMatchObject({
      code: 'COORDINATOR_PROFILE_NOT_FOUND'
    });
    expect(getDrop).not.toHaveBeenCalled();
  });

  it('preserves Wave validation without creating any records', async () => {
    const { service, getDrop, transaction } = setup();
    getDrop.mockResolvedValueOnce({
      ...sourceDrop(KEYS_AND_GATES_SOURCE_DROP_IDS[0]),
      wave_id: randomUUID()
    });
    await expect(
      importKeysAndGates(coordinator, true, service)
    ).rejects.toMatchObject({
      code: 'SOURCE_WAVE_MISMATCH'
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns the full unchanged dry-run roster when all sources exist', async () => {
    const { service, transaction, createWork } = setup();
    const result = await importKeysAndGates(coordinator, false, service);
    expect(result).toMatchObject({
      mode: 'dry_run',
      program_id: '6529NM-AP-01',
      coordinator_profile_id: coordinator,
      sources: KEYS_AND_GATES_SOURCE_DROP_IDS.map((id) => ({
        drop_id: id,
        owner_profile_id: expect.any(String),
        wave_id: waveId
      }))
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(createWork).not.toHaveBeenCalled();
  });
});
