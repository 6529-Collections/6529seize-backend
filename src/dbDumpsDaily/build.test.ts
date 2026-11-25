import { buildCommit as bakedCommit } from './build-commit';

// The build script is plain Node (CommonJS), run by `6529 run build`.
const { buildCommit } = require('./build.cjs') as {
  buildCommit: (git: (args: string[]) => string) => string;
};

const HEAD = 'c'.repeat(40);

describe("dbDumpsDaily's build commit", () => {
  it('is HEAD when no tracked file changed since it', () => {
    const git = jest.fn((args: string[]) =>
      args[0] === 'rev-parse' ? `${HEAD}\n` : '\n'
    );
    expect(buildCommit(git)).toBe(HEAD);
    expect(git).toHaveBeenCalledWith([
      'status',
      '--porcelain',
      '--untracked-files=no'
    ]);
  });

  it('is unknown with tracked changes, without git, or without a commit', () => {
    expect(
      buildCommit((args) =>
        args[0] === 'rev-parse' ? HEAD : ' M src/dbDumpsDaily/index.ts\n'
      )
    ).toBe('');
    expect(
      buildCommit(() => {
        throw new Error('git: not found');
      })
    ).toBe('');
    expect(buildCommit(() => 'HEAD')).toBe('');
  });

  it('reads as unknown when the code runs unbundled', () => {
    expect(bakedCommit()).toBeNull();
  });
});
