import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';
import { receiveLoopObservation } from './loop-monitor.js';
import { LOOP_EVENT_TYPE } from './loop-health.js';

const observation = {
  _type: LOOP_EVENT_TYPE,
  service: 'delegationsLoop',
  operation: 'indexing',
  observedAt: 100,
  pending: true,
  recovery: 'automatic'
};
const collision = () =>
  Object.assign(new Error('conditional write lost'), {
    name: 'ConditionalCheckFailedException'
  });

function harness(t: TestContext) {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  t.after(() => {
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  });
  let saved: Record<string, unknown> | undefined = {
    observedAt: 1,
    payload: { ...observation, observedAt: 1, baselineAt: 1 }
  };
  let writes = 0;
  let reads = 0;
  let beforeWrite: () => void = () => undefined;
  const signals: (AbortSignal | undefined)[] = [];
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(JSON.parse(line)));
  t.mock.method(
    ddb,
    'send',
    async (
      command: GetCommand | UpdateCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      signals.push(options?.abortSignal);
      if (command instanceof GetCommand) {
        reads++;
        return { Item: saved && { ...saved } };
      }
      writes++;
      beforeWrite();
      const values = command.input.ExpressionAttributeValues!;
      if (
        saved &&
        (Number(saved.observedAt) >= Number(values[':at']) ||
          saved.observedAt !== values[':expected'])
      )
        throw collision();
      saved = { observedAt: values[':at'], payload: values[':payload'] };
      return {};
    }
  );
  return {
    logs,
    signals,
    state: () => saved,
    writes: () => writes,
    reads: () => reads,
    onWrite: (fn: typeof beforeWrite) => {
      beforeWrite = fn;
    },
    advance: (at: number) => {
      saved = { ...saved, observedAt: at };
    },
    run: (observedAt = 100) =>
      receiveLoopObservation({ ...observation, observedAt }, 'staging')
  };
}

test('three competing writes recover in the same invocation without resetting stall tracking', async (t) => {
  const h = harness(t);
  h.onWrite(() => {
    if (h.writes() <= 3) h.advance(h.writes() + 1);
  });
  await h.run();
  assert.equal(h.writes(), 4);
  assert.equal(h.state()?.observedAt, 100);
  assert.equal((h.state()?.payload as { baselineAt: number }).baselineAt, 1);
  assert.ok(h.signals[0] instanceof AbortSignal);
  assert.ok(h.signals.every((signal) => signal === h.signals[0]));
  assert.equal(h.logs.at(-1)?.outcome, 'SAVED');
  assert.equal(h.logs.at(-1)?.conflicts, 3);
});

test('a newer observation saved on the last attempt makes the final read a successful no-op', async (t) => {
  const h = harness(t);
  h.onWrite(() => h.advance(h.writes() === 8 ? 101 : h.writes() + 1));
  await h.run();
  assert.equal(h.writes(), 8);
  assert.equal(h.reads(), 9);
  assert.equal(h.state()?.observedAt, 101);
  assert.equal(h.logs.at(-1)?.outcome, 'SUPERSEDED');
});

test('unresolved contention remains a failure and never acknowledges an unsaved observation', async (t) => {
  const h = harness(t);
  h.onWrite(() => h.advance(h.writes() + 1));
  await assert.rejects(h.run, /LOOP_OBSERVATION_CONFLICT/);
  assert.equal(h.writes(), 8);
  assert.equal(h.reads(), 9);
  assert.ok(Number(h.state()?.observedAt) < 100);
  assert.equal(h.logs.at(-1)?.outcome, 'FAILED');
  assert.equal(h.logs.at(-1)?.service, observation.service);
  assert.equal(h.logs.at(-1)?.operation, observation.operation);
  assert.match(String(h.logs.at(-1)?.observationHash), /^[a-f0-9]{64}$/);
});

test('storage errors retain their original identity without conditional-conflict retries or leaked messages', async (t) => {
  const h = harness(t);
  const failure = Object.assign(new Error('PRIVATE storage response'), {
    name: 'AccessDeniedException'
  });
  h.onWrite(() => {
    throw failure;
  });
  await assert.rejects(h.run, (error) => error === failure);
  assert.equal(h.writes(), 1);
  assert.equal(h.logs.at(-1)?.outcome, 'FAILED');
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
});

test('four writers converge on the newest status, and duplicate or older reports cannot overwrite it', async (t) => {
  const h = harness(t);
  await Promise.all([100, 101, 102, 103].map((at) => h.run(at)));
  assert.equal(h.state()?.observedAt, 103);
  const writes = h.writes();
  await h.run(103);
  await h.run(99);
  assert.equal(h.writes(), writes);
  assert.equal(h.state()?.observedAt, 103);
  assert.equal((h.state()?.payload as { baselineAt: number }).baselineAt, 1);
});

test('a blocked storage request shares the retry deadline and remains a failed observation', async (t) => {
  const h = harness(t);
  let requestSignal: AbortSignal | undefined;
  t.mock.method(
    ddb,
    'send',
    async (_command: GetCommand, options?: { abortSignal?: AbortSignal }) => {
      requestSignal = options?.abortSignal;
      assert.ok(requestSignal);
      await new Promise<void>((_resolve, reject) => {
        const keepAlive = setTimeout(
          () => reject(new Error('deadline not enforced')),
          5000
        );
        requestSignal!.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(requestSignal!.reason);
          },
          { once: true }
        );
      });
      return {};
    }
  );
  await assert.rejects(h.run, (error) => error === requestSignal?.reason);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(h.writes(), 0);
  assert.equal(h.state()?.observedAt, 1);
  assert.equal(h.logs.at(-1)?.outcome, 'FAILED');
});

test('a final read after the deadline fails closed even if a competing writer saved newer state', async (t) => {
  const h = harness(t);
  let writes = 0;
  let finalRead = false;
  let requestSignal: AbortSignal | undefined;
  t.mock.method(
    ddb,
    'send',
    async (
      command: GetCommand | UpdateCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      requestSignal = options?.abortSignal;
      assert.ok(requestSignal);
      if (command instanceof GetCommand) {
        if (writes === 8) {
          finalRead = true;
          requestSignal.throwIfAborted();
          return { Item: { observedAt: 101 } };
        }
        return { Item: { observedAt: writes + 1, payload: observation } };
      }
      writes++;
      if (writes === 8) {
        await new Promise<void>((resolve) => {
          const keepAlive = setTimeout(resolve, 5000);
          requestSignal!.addEventListener(
            'abort',
            () => {
              clearTimeout(keepAlive);
              resolve();
            },
            { once: true }
          );
        });
      }
      throw collision();
    }
  );
  await assert.rejects(h.run, (error) => error === requestSignal?.reason);
  assert.equal(writes, 8);
  assert.equal(finalRead, true);
  assert.equal(h.logs.at(-1)?.outcome, 'FAILED');
});
