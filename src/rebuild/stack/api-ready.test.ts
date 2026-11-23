import { waitForApi } from '@/rebuild/stack/api-ready';

describe('waiting for the API', () => {
  it('is done when the API answers', async () => {
    let calls = 0;
    expect(
      await waitForApi({
        answers: async () => ++calls === 3,
        ended: () => false,
        timeoutMs: 5_000,
        pauseMs: 1
      })
    ).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up when the API never answers, or ends first', async () => {
    expect(
      await waitForApi({
        answers: async () => false,
        ended: () => false,
        timeoutMs: 50,
        pauseMs: 5
      })
    ).toBe(false);
    expect(
      await waitForApi({
        answers: async () => false,
        ended: () => true,
        timeoutMs: 5_000,
        pauseMs: 5
      })
    ).toBe(false);
  });
});
