import { DropForgeRepository } from './drop-forge.repository';
import { recordPostMintPreview } from './drop-forge.preview';
import { readForgeSettings } from './drop-forge.settings';
import { LaunchRecord, SupplyEvidenceError } from './drop-forge.types';
import { testConfig, testLaunchData } from './drop-forge.test-fixtures';
jest.mock('./drop-forge.settings', () => ({ readForgeSettings: jest.fn() }));
function fixture() {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 0,
    data: testLaunchData()
  };
  const repository = new DropForgeRepository();
  jest
    .spyOn(repository, 'change')
    .mockImplementation(async (_id, change) => change(record, {}));
  const chain = {
    previewPostMint: jest.fn().mockResolvedValue({
      evidence: {
        status: 'VERIFIED',
        rpc_total: 287,
        db_total: 287,
        block_number: 100,
        checked_at: 1
      },
      research: 18
    })
  };
  return {
    record,
    chain,
    run: (now = 7900) =>
      recordPostMintPreview(record.id, testConfig, repository, chain, now)
  };
}
beforeEach(() => {
  jest.mocked(readForgeSettings).mockResolvedValue({
    id: 'settings',
    revision: 1,
    automation_enabled: true,
    pay_artist_enabled: false,
    updated_by: null,
    updated_at: 0
  });
});
afterEach(() => jest.restoreAllMocks());
it('posts one untagged preview at close plus fifteen minutes and never repeats its calculation', async () => {
  const f = fixture();
  await f.run(7899);
  expect(f.chain.previewPostMint).not.toHaveBeenCalled();
  await f.run();
  await f.run();
  expect(f.chain.previewPostMint).toHaveBeenCalledTimes(1);
  const event = f.record.data.events.at(-1)!;
  expect(event.error).toBe(false);
  expect(event.formatted).toBe(true);
  expect(event.content).toContain('**18 editions**');
  expect(event.content).not.toContain('@');
  expect(event.content).not.toMatch(/^#/m);
});
it('records a mismatch once for the operations outbox with no calculation retry', async () => {
  const f = fixture();
  f.chain.previewPostMint.mockRejectedValue(
    new SupplyEvidenceError(
      { status: 'WAITING', checked_at: 1, rpc_total: 287, db_total: 286 },
      'Mint accounting mismatch'
    )
  );
  await f.run();
  await f.run();
  expect(f.chain.previewPostMint).toHaveBeenCalledTimes(1);
  expect(f.record.data.events.at(-1)).toMatchObject({
    error: true,
    formatted: true
  });
  expect(f.record.data.post_mint_preview?.error).toContain('mismatch');
});
it('does not present disabled automation as a promised transfer', async () => {
  jest.mocked(readForgeSettings).mockResolvedValue({
    id: 'settings',
    revision: 1,
    automation_enabled: false,
    pay_artist_enabled: false,
    updated_by: null,
    updated_at: 0
  });
  const f = fixture();
  await f.run();
  expect(f.record.data.events.at(-1)?.content).toContain(
    'Automatic launch is Off'
  );
});
it('does not calculate a missed preview during the actual execution window', async () => {
  const f = fixture();
  await f.run(10600);
  expect(f.chain.previewPostMint).not.toHaveBeenCalled();
  expect(f.record.data.events.at(-1)?.error).toBe(false);
});
