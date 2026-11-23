import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { LAMBDAS_SECRET_ID, readFreshSecretValue } from './fresh-secret';

function client(answers: (object | Error)[]) {
  const send = jest.fn(async (_command: GetSecretValueCommand) => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { send } as never as { send: typeof send };
}

const noWait = async () => undefined;

describe('readFreshSecretValue', () => {
  it('reads one key of prod/lambdas as it is now', async () => {
    const c = client([
      {
        SecretString: JSON.stringify({
          IDENTITY_FREEZE_AT: '2026-11-24T00:00:00Z',
          OTHER: 'x'
        })
      }
    ]);
    await expect(
      readFreshSecretValue(c as never, 'IDENTITY_FREEZE_AT', undefined, noWait)
    ).resolves.toEqual({
      secretId: 'prod/lambdas',
      key: 'IDENTITY_FREEZE_AT',
      value: '2026-11-24T00:00:00Z'
    });
    expect(LAMBDAS_SECRET_ID).toBe('prod/lambdas');
    const command = c.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect(command.input).toEqual({ SecretId: 'prod/lambdas' });
  });

  it.each([
    [{}, undefined],
    [{ IDENTITY_FREEZE_AT: null }, undefined],
    [{ IDENTITY_FREEZE_AT: 1795996800000 }, '1795996800000'],
    [{ IDENTITY_FREEZE_AT: '' }, '']
  ])('reads %j as the environment would: %j', async (secret, value) => {
    const c = client([{ SecretString: JSON.stringify(secret) }]);
    const read = await readFreshSecretValue(
      c as never,
      'IDENTITY_FREEZE_AT',
      undefined,
      noWait
    );
    expect(read.value).toBe(value);
  });

  it('tries three times, then gives the last error', async () => {
    const ok = client([
      new Error('throttled'),
      new Error('reset'),
      { SecretString: '{"K":"v"}' }
    ]);
    await expect(
      readFreshSecretValue(ok as never, 'K', undefined, noWait)
    ).resolves.toMatchObject({ value: 'v' });
    expect(ok.send).toHaveBeenCalledTimes(3);
    const failing = client([
      new Error('a'),
      new Error('b'),
      new Error('access denied')
    ]);
    await expect(
      readFreshSecretValue(failing as never, 'K', undefined, noWait)
    ).rejects.toThrow('access denied');
  });

  it("refuses a secret that isn't JSON without quoting its text", async () => {
    const c = client([
      { SecretString: '{"IDENTITY_FREEZE_AT": "x", "DB_PASS": "hunter2"' }
    ]);
    const error = await readFreshSecretValue(
      c as never,
      'IDENTITY_FREEZE_AT',
      undefined,
      noWait
    ).catch((e) => e);
    expect(error.message).toBe('The secret prod/lambdas is not valid JSON');
    expect(error.message).not.toMatch(/hunter2|DB_PASS/);
  });

  it('refuses a secret with no text value', async () => {
    const c = client([{ SecretBinary: new Uint8Array([1]) }]);
    await expect(
      readFreshSecretValue(c as never, 'K', undefined, noWait)
    ).rejects.toThrow(/no text value/);
  });
});
