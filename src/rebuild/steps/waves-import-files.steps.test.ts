import { RebuildContext } from '@/rebuild/manifest.types';
import {
  assertNoRefusals,
  rebuildWavesImportFiles
} from './waves-import-files.steps';

function context(): RebuildContext {
  return {
    area: 'waves',
    stepId: 'waves.import-files',
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files: null,
      repo: null
    },
    seedFilesDir: null,
    mark: { name: 'head', chainHeight: null, ethBlock: null }
  };
}

describe('the waves import-files step', () => {
  it('needs a gateway and a files source', async () => {
    await expect(rebuildWavesImportFiles(context())).rejects.toThrow(
      'needs a gateway and a files source'
    );
  });

  it('fails on any refusal, naming the count', () => {
    const report = {
      wavesFileHash: null,
      dropArchiveRoot: null,
      archives: 2,
      written: 1,
      drops: 3,
      parts: 3,
      refused: [{ waveId: '0xab', reason: 'it hashes to something else' }]
    };
    expect(() => assertNoRefusals(report)).toThrow(
      '[DROP ARCHIVES REFUSED] 1 refused'
    );
    expect(() => assertNoRefusals({ ...report, refused: [] })).not.toThrow();
  });
});
