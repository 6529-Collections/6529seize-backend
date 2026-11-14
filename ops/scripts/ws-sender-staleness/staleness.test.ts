import { deployedCommit, findStaleSenders } from './staleness';

describe('deployedCommit', () => {
  it('reads the commit from a deploy workflow description', () => {
    expect(
      deployedCommit(
        'eef9a911e - Sat Nov  7 01:35:27 UTC 2026 - HEAD - Merge pull request #2321'
      )
    ).toBe('eef9a911e');
  });

  it('returns null for descriptions without a commit', () => {
    expect(deployedCommit('')).toBeNull();
    expect(deployedCommit('Manually deployed')).toBeNull();
  });
});

describe('findStaleSenders', () => {
  const functions = [
    { name: 'seizeAPI', description: 'aaaaaaa1 - date - HEAD - new' },
    { name: 'waveDecisionExecutionLoop', description: 'bbbbbbb2 - old' },
    { name: 'tdhLoop', description: 'ccccccc3 - old' },
    { name: 'mystery', description: 'no commit here' },
    { name: 'gone', description: 'ddddddd4 - unknown locally' }
  ];
  const deps = {
    sendsFrames: async (name: string) => name !== 'tdhLoop',
    knows: async (commit: string) => commit !== 'ddddddd4',
    contains: async (deployed: string) => deployed === 'aaaaaaa1'
  };

  it('reports only senders, stale first, and never a silent function', async () => {
    const reports = await findStaleSenders(functions, 'required', deps);
    expect(reports).toEqual([
      {
        name: 'waveDecisionExecutionLoop',
        commit: 'bbbbbbb2',
        status: 'stale'
      },
      { name: 'gone', commit: 'ddddddd4', status: 'unknown-commit' },
      { name: 'mystery', commit: null, status: 'unknown-commit' },
      { name: 'seizeAPI', commit: 'aaaaaaa1', status: 'current' }
    ]);
  });

  it('asks git whether the required commit is in each deployed commit', async () => {
    const contains = jest.fn(async () => true);
    await findStaleSenders(functions.slice(0, 1), 'required', {
      ...deps,
      contains
    });
    expect(contains).toHaveBeenCalledWith('aaaaaaa1', 'required');
  });
});
