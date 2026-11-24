import { assertNoRefusals } from './waves-import-files.steps';

describe('the drop archive import for a rebuild', () => {
  it('fails on any refusal, naming the count', () => {
    const report = {
      wavesFileHash: null,
      dropArchiveRoot: null,
      archives: 2,
      written: 1,
      drops: 3,
      parts: 3,
      refused: [{ waveId: '0xab', reason: 'it hashes to something else' }],
      skipped: [],
      descriptionDropIds: new Map<string, string>(),
      descriptionsUnresolved: []
    };
    expect(() => assertNoRefusals(report)).toThrow(
      '[DROP ARCHIVES REFUSED] 1 refused'
    );
    expect(() => assertNoRefusals({ ...report, refused: [] })).not.toThrow();
  });
});
