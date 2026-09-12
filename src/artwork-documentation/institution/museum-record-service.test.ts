import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import { emptyCapabilities } from '../artwork-documentation.access';
import { ArtworkDocumentationDb } from '../artwork-documentation.db';
import { ArtworkDocumentationService } from '../artwork-documentation.service';
import { AD_MUSEUM_RECORDS } from '../artwork-documentation.tables';
import { ContextAccess, Mutation } from '../artwork-documentation.types';
import { digest, fail } from '../artwork-documentation.validation';
import { artworkAssetsService } from '../assets/artwork-assets.service';
import { dossierFixture } from '../museum/export/dossier-fixture';
import { MuseumRecordService } from './museum-record.service';
import { MuseumRecordInput } from './museum-record.validation';

function fixture() {
  const { snapshot } = dossierFixture();
  const context = snapshot.context;
  const transaction: RequestContext = { connection: { connection: {} } };
  const access: ContextAccess = {
    context,
    actorProfileId: 'test-reviewer',
    isArtist: false,
    capabilities: {
      ...emptyCapabilities(),
      read_context: true,
      review_lanes: ['curatorial'],
      read_archival_files: true
    }
  };
  const records: Record<string, unknown>[] = [];
  const requests = new Map<
    string,
    { hash: string; result: Record<string, unknown> }
  >();
  const db = {
    idempotent: jest.fn(
      async (
        id: string,
        hash: string,
        _ctx: RequestContext,
        run: (tx: RequestContext) => Promise<Record<string, unknown>>
      ) => {
        const previous = requests.get(id);
        if (previous && previous.hash !== hash)
          fail(409, 'IDEMPOTENCY_MISMATCH');
        if (previous) return previous.result;
        const result = await run(transaction);
        requests.set(id, { hash, result });
        return result;
      }
    ),
    insert: jest.fn(async (table: string, row: Record<string, unknown>) => {
      if (table === AD_MUSEUM_RECORDS) records.push(row);
    }),
    one: jest.fn(
      async (_sql: string, params: Record<string, unknown>) =>
        records.find(
          (row) => row.context_id === params.id && row.id === params.recordId
        ) ?? null
    ),
    query: jest.fn(async () => records),
    saveContext: jest.fn()
  };
  const core = new ArtworkDocumentationService(
    db as unknown as ArtworkDocumentationDb
  );
  jest.spyOn(core, 'actor').mockReturnValue(access.actorProfileId);
  const authorize = jest
    .spyOn(core, 'authorizeContext')
    .mockResolvedValue(access);
  const mutationAccess = jest
    .spyOn(core, 'authorizeMutationContext')
    .mockResolvedValue(access);
  jest
    .spyOn(core, 'mutationCapabilities')
    .mockResolvedValue(access.capabilities);
  const service = new MuseumRecordService(core);
  const input: MuseumRecordInput = {
    kind: 'catalogue_note',
    title: 'Synthetic research note',
    event_status: 'completed',
    subject_ids: [context.work_id],
    evidence_asset_ids: [],
    details: {
      source: 'Synthetic test source',
      conclusion: 'Synthetic test finding'
    }
  };
  const mutation = (body = input): Mutation => ({
    key: 'request-1',
    route: `/contexts/${context.id}/museum-records`,
    body,
    expectedVersion: context.draft_version
  });
  return {
    service,
    core,
    db,
    context,
    access,
    transaction,
    authorize,
    mutationAccess,
    input,
    mutation,
    records,
    snapshot
  };
}

afterEach(() => jest.restoreAllMocks());

it('paginates ten large journal entries with a bounded escaped response and an eleventh-row cursor', async () => {
  const f = fixture();
  for (let index = 0; index < 11; index++)
    f.records.push({
      id: `record-${index}`,
      context_id: f.context.id,
      actor_profile_id: f.access.actorProfileId,
      source_revision_id: null,
      source_draft_version: 1,
      created_at: 1,
      sha256: 'a'.repeat(64),
      payload_json: JSON.stringify({
        ...f.input,
        statement: '"'.repeat(50000),
        details: { source: 'Synthetic test', conclusion: '"'.repeat(12000) }
      })
    });
  const page = await f.service.list(f.context.id, {});
  expect(page.records).toHaveLength(10);
  expect(page.next_cursor).toBe('record-9');
  expect(
    Buffer.byteLength(JSON.stringify({ body: JSON.stringify(page) }))
  ).toBeLessThan(4 * 1024 ** 2);
  expect(f.db.query).toHaveBeenCalledWith(
    expect.stringContaining('LIMIT 11'),
    expect.any(Object),
    {}
  );
});

it('appends attributed immutable evidence transactionally without changing artist confirmation or draft', async () => {
  const f = fixture();
  const before = JSON.stringify(f.context);
  const input = { ...f.input, evidence_asset_ids: [f.snapshot.assets[0].id] };
  const ready = jest
    .spyOn(artworkAssetsService, 'validateReadyAsset')
    .mockResolvedValue({ ...f.snapshot.assets[0], has_preview: false });
  const first = await f.service.append(
    f.context.id,
    input,
    f.mutation(input),
    {}
  );
  const replay = await f.service.append(
    f.context.id,
    input,
    f.mutation(input),
    {}
  );
  expect(first).toEqual(replay);
  expect(f.records).toHaveLength(1);
  expect(JSON.stringify(f.context)).toBe(before);
  expect(f.db.saveContext).not.toHaveBeenCalled();
  expect(
    f.db.insert.mock.calls.every(
      (call) => (call as unknown[])[2] === f.transaction
    )
  ).toBe(true);
  expect(ready).toHaveBeenCalledWith(
    f.context.id,
    f.snapshot.assets[0].id,
    expect.objectContaining({ publicationOnlyV3: true }),
    f.transaction.connection
  );
  expect(first.payload).toMatchObject({
    recording_basis: 'database_account_authentication',
    evidence: [
      {
        asset_id: f.snapshot.assets[0].id,
        sha256: f.snapshot.assets[0].sha256,
        size_bytes: f.snapshot.assets[0].size_bytes
      }
    ]
  });
  expect(first.sha256).toBe(
    digest({
      id: first.id,
      context_id: first.context_id,
      actor_profile_id: first.actor_profile_id,
      source_revision_id: first.source_revision_id,
      source_draft_version: first.source_draft_version,
      created_at: first.created_at,
      payload: first.payload
    })
  );
});

it('checks fresh transaction grants before any museum or audit insert', async () => {
  const f = fixture();
  f.mutationAccess.mockResolvedValue({
    ...f.access,
    capabilities: { ...f.access.capabilities, review_lanes: ['technical'] }
  });
  await expect(
    f.service.append(f.context.id, f.input, f.mutation(), {})
  ).rejects.toMatchObject({ code: 'REVIEW_NOT_ALLOWED' });
  expect(f.mutationAccess).toHaveBeenCalledWith(
    f.context.id,
    f.transaction,
    true
  );
  expect(f.db.insert).not.toHaveBeenCalled();
});

it('rechecks access on idempotent replay and rejects a changed request body', async () => {
  const f = fixture();
  await f.service.append(f.context.id, f.input, f.mutation(), {});
  const changed = { ...f.input, title: 'Changed' };
  await expect(
    f.service.append(f.context.id, changed, f.mutation(changed), {})
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  f.authorize
    .mockResolvedValueOnce(f.access)
    .mockRejectedValueOnce(new Error('revoked'));
  await expect(
    f.service.append(f.context.id, f.input, f.mutation(), {})
  ).rejects.toThrow('revoked');
  expect(f.records).toHaveLength(1);
});

it.each(['invalid', 'stale', 'archived'])(
  'rejects %s work before museum or audit writes',
  async (scenario) => {
    const f = fixture();
    if (scenario === 'archived') f.context.lifecycle = 'archived';
    const mutation = f.mutation();
    if (scenario === 'stale') mutation.expectedVersion = 0;
    await expect(
      f.service.append(
        f.context.id,
        scenario === 'invalid' ? {} : f.input,
        mutation,
        {}
      )
    ).rejects.toBeDefined();
    expect(f.db.insert).not.toHaveBeenCalled();
  }
);

it.each(['absent', 'foreign', 'wrong_kind'])(
  'rejects a loan referencing an %s condition record before evidence reads',
  async (scenario) => {
    const f = fixture();
    const conditionId = randomUUID();
    if (scenario !== 'absent')
      f.records.push({
        id: conditionId,
        context_id: scenario === 'foreign' ? randomUUID() : f.context.id,
        kind: scenario === 'wrong_kind' ? 'catalogue_note' : 'condition'
      });
    const input: MuseumRecordInput = {
      ...f.input,
      kind: 'loan',
      details: {
        lender: 'Museum A',
        borrower: 'Museum B',
        start: '2026-09-12',
        agreement_asset_id: f.snapshot.assets[0].id,
        outbound_condition_record_id: conditionId,
        conditions: 'Synthetic loan'
      }
    };
    const ready = jest.spyOn(artworkAssetsService, 'validateReadyAsset');
    await expect(
      f.service.append(f.context.id, input, f.mutation(input), {})
    ).rejects.toMatchObject({ code: 'INVALID_CONDITION_REFERENCE' });
    expect(f.db.one).toHaveBeenCalledWith(
      expect.stringContaining('context_id=:id AND id=:recordId'),
      { id: f.context.id, recordId: conditionId },
      f.transaction
    );
    expect(ready).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  }
);

it('accepts an existing local condition record and rejects an invalid return condition reference', async () => {
  const f = fixture();
  const outbound = randomUUID();
  f.records.push({ id: outbound, context_id: f.context.id, kind: 'condition' });
  const input: MuseumRecordInput = {
    ...f.input,
    kind: 'loan',
    details: {
      lender: 'Museum A',
      borrower: 'Museum B',
      start: '2026-09-12',
      agreement_asset_id: f.snapshot.assets[0].id,
      outbound_condition_record_id: outbound,
      conditions: 'Synthetic loan'
    }
  };
  jest
    .spyOn(artworkAssetsService, 'validateReadyAsset')
    .mockResolvedValue({ ...f.snapshot.assets[0], has_preview: false });
  const result = await f.service.append(
    f.context.id,
    input,
    f.mutation(input),
    {}
  );
  expect(result.payload.details.outbound_condition_record_id).toBe(outbound);
  const invalidReturn = {
    ...input,
    details: { ...input.details, return_condition_record_id: randomUUID() }
  };
  await expect(
    f.service.append(
      f.context.id,
      invalidReturn,
      { ...f.mutation(invalidReturn), key: 'request-2' },
      {}
    )
  ).rejects.toMatchObject({ code: 'INVALID_CONDITION_REFERENCE' });
  expect(f.records).toHaveLength(2);
});
