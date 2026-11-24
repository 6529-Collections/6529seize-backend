import { stepContext } from '@/rebuild/run/step-context';

describe('step context', () => {
  const input = {
    area: 'identity',
    stepId: 'identity.chain-mirror',
    kind: 'rebuilder' as const,
    sources: {
      gateway: 'http://127.0.0.1:1',
      relays: null,
      ethereum: null,
      files: 'http://127.0.0.1:2',
      repo: null
    },
    seedFilesDir: 'runs/x/seed-files',
    mark: { name: 'head' as const, chainHeight: 9, ethBlock: null }
  };

  it('tells a step whether the run is final', () => {
    expect(stepContext({ ...input, final: true }).final).toBe(true);
    expect(stepContext({ ...input, final: false }).final).toBe(false);
  });

  it('gives a seed, and only a seed, a files directory when the run serves files', () => {
    expect(stepContext({ ...input, final: false }).seedFilesDir).toBeNull();
    expect(
      stepContext({ ...input, kind: 'seed', final: false }).seedFilesDir
    ).toBe('runs/x/seed-files');
    expect(
      stepContext({
        ...input,
        kind: 'seed',
        sources: { ...input.sources, files: null },
        final: false
      }).seedFilesDir
    ).toBeNull();
  });
});
