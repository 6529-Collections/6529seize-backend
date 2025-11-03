import { loggerContext } from './logger-context';

describe('loggerContext', () => {
  it('exposes the initial context within the run callback', () => {
    let requestId: string | undefined;
    let jwtSub: string | undefined;

    loggerContext.run({ requestId: 'req-1', jwtSub: 'wallet-1' }, () => {
      const store = loggerContext.get();
      requestId = store?.requestId;
      jwtSub = store?.jwtSub;
    });

    expect(requestId).toBe('req-1');
    expect(jwtSub).toBe('wallet-1');
  });

  it('keeps context across async boundaries', async () => {
    let requestId: string | undefined;

    await new Promise<void>((resolve) => {
      loggerContext.run({ requestId: 'req-async' }, () => {
        Promise.resolve()
          .then(() => {
            requestId = loggerContext.get()?.requestId;
          })
          .then(() => resolve());
      });
    });

    expect(requestId).toBe('req-async');
  });

  it('updates context fields through setter helpers', () => {
    let contextRequestId: string | undefined;
    let contextJwtSub: string | undefined;

    loggerContext.run({}, () => {
      loggerContext.setRequestId('req-updated');
      loggerContext.setJwtSub('wallet-updated');
      const store = loggerContext.get();
      contextRequestId = store?.requestId;
      contextJwtSub = store?.jwtSub;
    });

    expect(contextRequestId).toBe('req-updated');
    expect(contextJwtSub).toBe('wallet-updated');
  });
});
