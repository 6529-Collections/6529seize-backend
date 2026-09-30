import { randomUUID } from 'node:crypto';
import {
  COMPETITION_COMMANDS_TABLE,
  COMPETITION_SIGNATURE_NONCES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { competitionCommandRepository as repository } from './competition-command.repository';

describeWithSeed('Native command transactions', [], () => {
  it('executes concurrent identical retries once and rejects changed payloads', async () => {
    const key = randomUUID();
    const execute = jest.fn(async () => ({ result: randomUUID() }));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.command('actor', key, { value: 1 }, execute, {})
      )
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.result === results[0].result)).toBe(
      true
    );
    await expect(
      repository.findSavedCommand('actor', key, { value: 1 }, {})
    ).resolves.toEqual(results[0]);
    await expect(
      repository.command('actor', key, { value: 2 }, execute, {})
    ).rejects.toThrow('another request');
    await expect(
      repository.findSavedCommand('actor', key, { value: 2 }, {})
    ).rejects.toThrow('another request');
  });

  it('rolls back the command receipt and consumed signature together on failure', async () => {
    const key = randomUUID();
    const nonce = randomUUID();
    await expect(
      repository.command(
        'actor',
        key,
        {},
        async (ctx) => {
          await repository.consumeNonce(
            'competition',
            'actor',
            'ENTRY_CREATE',
            nonce,
            ctx
          );
          throw new Error('injected write failure');
        },
        {}
      )
    ).rejects.toThrow('injected write failure');
    expect(
      await sqlExecutor.execute(`SELECT id FROM ${COMPETITION_COMMANDS_TABLE}`)
    ).toEqual([]);
    expect(
      await sqlExecutor.execute(
        `SELECT id FROM ${COMPETITION_SIGNATURE_NONCES_TABLE}`
      )
    ).toEqual([]);
    await expect(
      repository.command(
        'actor',
        key,
        {},
        async (ctx) => {
          await repository.consumeNonce(
            'competition',
            'actor',
            'ENTRY_CREATE',
            nonce,
            ctx
          );
          return { ok: true };
        },
        {}
      )
    ).resolves.toEqual({ ok: true });
    await expect(
      repository.command(
        'actor',
        randomUUID(),
        {},
        async (ctx) => {
          await repository.consumeNonce(
            'competition',
            'actor',
            'ENTRY_CREATE',
            nonce,
            ctx
          );
          return { ok: true };
        },
        {}
      )
    ).rejects.toThrow('already consumed');
  });

  it('separates retry receipts for different effective actors', async () => {
    const key = randomUUID();
    await expect(
      repository.command('first', key, {}, async () => ({ actor: 'first' }), {})
    ).resolves.toEqual({ actor: 'first' });
    await expect(
      repository.command(
        'second',
        key,
        {},
        async () => ({ actor: 'second' }),
        {}
      )
    ).resolves.toEqual({ actor: 'second' });
  });
});
