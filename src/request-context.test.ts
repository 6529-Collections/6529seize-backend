import { getRequestScopedPromise, RequestContext } from './request.context';

describe('getRequestScopedPromise', () => {
  it('reuses an in-flight promise for matching keys on the same context', async () => {
    const ctx: RequestContext = {};
    const getValue = jest.fn().mockResolvedValue('value');

    const [first, second] = await Promise.all([
      getRequestScopedPromise(ctx, 'key', getValue),
      getRequestScopedPromise(ctx, 'key', getValue)
    ]);

    expect(first).toBe('value');
    expect(second).toBe('value');
    expect(getValue).toHaveBeenCalledTimes(1);
  });

  it('evicts rejected promises so later calls retry', async () => {
    const ctx: RequestContext = {};
    const getValue = jest
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('retry value');

    await expect(getRequestScopedPromise(ctx, 'key', getValue)).rejects.toThrow(
      'first failure'
    );
    await expect(getRequestScopedPromise(ctx, 'key', getValue)).resolves.toBe(
      'retry value'
    );
    expect(getValue).toHaveBeenCalledTimes(2);
  });

  it('keeps the request scope off enumerable context copies', async () => {
    const ctx: RequestContext = {};

    await getRequestScopedPromise(ctx, 'key', async () => 'value');

    expect(Object.keys(ctx)).not.toContain('requestScope');
    expect({ ...ctx }).not.toHaveProperty('requestScope');
  });
});
