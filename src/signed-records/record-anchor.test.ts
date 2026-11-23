import { handleGetSignedRecordsAnchor } from '@/api/signed-records/signed-records.handlers';
import { MAX_ANCHOR_LAG, RecordAnchorService } from './record-anchor';

describe('the record anchor', () => {
  it('is the finalized height the gateway reports', async () => {
    const service = new RecordAnchorService();
    service.setSource({
      getHead: async () => ({
        headHeight: 1203,
        finalizedHeight: 1200,
        finalizedTime: 1_764_000_000_000
      })
    });
    await expect(
      handleGetSignedRecordsAnchor({} as never, service)
    ).resolves.toEqual({
      anchor: 1200,
      head_height: 1203,
      finalized_time: 1_764_000_000_000,
      max_anchor_lag: MAX_ANCHOR_LAG
    });
  });

  it('answers 503 until the gateway client is wired in', async () => {
    const service = new RecordAnchorService();
    await expect(service.getAnchor()).rejects.toMatchObject({
      code: 'ANCHOR_UNAVAILABLE'
    });
    const error = await service.getAnchor().catch((e: unknown) => e);
    expect((error as { getStatusCode(): number }).getStatusCode()).toBe(503);
  });

  it('answers 503 when the gateway does not answer', async () => {
    const service = new RecordAnchorService();
    service.setSource({
      getHead: () => Promise.reject(new Error('gateway timed out'))
    });
    await expect(service.getAnchor()).rejects.toMatchObject({
      code: 'ANCHOR_UNAVAILABLE'
    });
  });
});
