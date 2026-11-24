import { createHash } from 'node:crypto';
import { TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE } from '@/constants';
import { mintManifest } from '@/rebuild/manifests/mint.manifest';
import { RecordLogReader } from '@/signed-records/record-log/record-log-reader';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { rebuildMintLogInCheck } from './mint-log-rebuild-check.steps';
import {
  mintRebuiltTables,
  rebuildMintLogFromRecordLog
} from './mint-log-rebuild.run';

jest.mock('@/signed-records/record-log/records-wave-local-reader', () => ({
  LocalRecordsWaveReader: jest.fn()
}));
jest.mock('./mint-log-rebuild.run', () => ({
  ...jest.requireActual('./mint-log-rebuild.run'),
  rebuildMintLogFromRecordLog: jest.fn()
}));

const ENV = {
  SIGNED_RECORDS_WAVE_ID: '00000000-0000-4000-8000-00000000f0a1',
  SIGNED_RECORDS_SERVICE_PROFILE_ID: 'mint-steps-test-records-service',
  SIGNED_RECORDS_SERVICE_WALLET: '0x00000000000000000000000000000000000000F1',
  SIGNED_RECORDS_PROVIDER_KEYS: JSON.stringify([
    {
      id: 'mint-steps-test',
      private_key: `0x${createHash('sha256')
        .update('mint steps test: a provider key made only for this test')
        .digest('hex')}`
    }
  ])
};

describe('the mint log rebuilder in the rebuild check', () => {
  beforeEach(() => {
    jest.mocked(LocalRecordsWaveReader).mockClear();
    jest.mocked(rebuildMintLogFromRecordLog).mockReset();
  });

  it('declares exactly the tables the rebuild writes, and the cursor it sets', () => {
    const step = mintManifest.rebuilders.find((it) => it.id === 'mint.log');
    expect([...(step?.writes ?? [])].sort()).toEqual(
      [
        ...mintRebuiltTables(),
        TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
      ].sort()
    );
  });

  it("reads the record log's heads from the records wave in 6529.io's drops", async () => {
    jest.mocked(rebuildMintLogFromRecordLog).mockResolvedValue({
      entries: 3,
      cards: 1,
      heads: { mint: { seq: 2, hash: 'h' } }
    });

    await rebuildMintLogInCheck(
      { sources: { files: 'http://127.0.0.1:1', ethereum: null } },
      ENV
    );

    expect(LocalRecordsWaveReader).toHaveBeenCalledTimes(1);
    expect(LocalRecordsWaveReader).toHaveBeenCalledWith({
      waveId: ENV.SIGNED_RECORDS_WAVE_ID,
      profileId: ENV.SIGNED_RECORDS_SERVICE_PROFILE_ID,
      wallet: ENV.SIGNED_RECORDS_SERVICE_WALLET.toLowerCase()
    });
    const [{ source }] = jest.mocked(rebuildMintLogFromRecordLog).mock.calls[0];
    expect(source).toBeInstanceOf(RecordLogReader);
  });

  it('stops when the records wave is not configured', async () => {
    await expect(
      rebuildMintLogInCheck(
        { sources: { files: 'http://127.0.0.1:1', ethereum: null } },
        { ...ENV, SIGNED_RECORDS_WAVE_ID: undefined }
      )
    ).rejects.toThrow('The mint log rebuild reads the records wave');
    expect(rebuildMintLogFromRecordLog).not.toHaveBeenCalled();
  });

  it('stops when the log holds no mint entry', async () => {
    jest.mocked(rebuildMintLogFromRecordLog).mockResolvedValue({
      entries: 0,
      cards: 0,
      heads: {}
    });
    await expect(
      rebuildMintLogInCheck(
        { sources: { files: 'http://127.0.0.1:1', ethereum: null } },
        ENV
      )
    ).rejects.toThrow('The record log holds no mint entry');
  });
});
