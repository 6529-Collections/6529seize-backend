import { forEachConcurrent } from './for-each-concurrent';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushWork() {
  await Array.from({ length: 8 }).reduce<Promise<void>>(
    (previous) => previous.then(() => undefined),
    Promise.resolve()
  );
}

it('reuses individual slots without exceeding the limit or waiting for a whole batch', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  const operation = forEachConcurrent(
    gates.keys(),
    async (index) => {
      started.push(index);
      active++;
      maximum = Math.max(maximum, active);
      await gates[index].promise;
      active--;
    },
    { concurrency: 2 }
  );
  await flushWork();
  expect(started).toEqual([0, 1]);
  gates[0].resolve();
  await flushWork();
  expect(started).toEqual([0, 1, 2]);
  gates.forEach((gate) => gate.resolve());
  await operation;
  expect(started).toEqual([0, 1, 2, 3, 4]);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
});

it('stops consuming on cancellation while awaiting already-started operations', async () => {
  const controller = new AbortController();
  const gates = [deferred(), deferred()];
  const consumed: number[] = [];
  function* items() {
    for (let i = 0; i < 8; i++) {
      consumed.push(i);
      yield i;
    }
  }
  const visit = jest.fn((index: number) => gates[index].promise);
  let settled = false;
  const operation = forEachConcurrent(items(), visit, {
    concurrency: 2,
    signal: controller.signal
  }).then(() => {
    settled = true;
  });
  await flushWork();
  controller.abort();
  gates[0].resolve();
  await flushWork();
  expect(settled).toBe(false);
  expect(consumed).toEqual([0, 1]);
  gates[1].resolve();
  await operation;
  expect(visit).toHaveBeenCalledTimes(2);
});

it('does not start work for an already-aborted signal', async () => {
  const controller = new AbortController();
  const visit = jest.fn();
  controller.abort();
  const operation = forEachConcurrent([1, 2, 3], visit, {
    concurrency: 2,
    signal: controller.signal
  });
  await operation;
  expect(visit).not.toHaveBeenCalled();
});

it('drains recipients after synchronous and asynchronous failures and reports the first error after settlement', async () => {
  const error = new Error('first failure');
  const gate = deferred();
  const visited: number[] = [];
  const operation = forEachConcurrent(
    [0, 1, 2, 3],
    (index) => {
      visited.push(index);
      if (index === 0) throw error;
      if (index === 1) return Promise.reject(new Error('later failure'));
      if (index === 2) return gate.promise;
      return Promise.resolve();
    },
    { concurrency: 2 }
  );
  const rejected = expect(operation).rejects.toBe(error);
  await flushWork();
  expect(visited).toEqual([0, 1, 2, 3]);
  gate.resolve();
  await rejected;
});

it('stops after an iterator fails and waits for the other active worker', async () => {
  const error = new Error('iterator failed');
  const gate = deferred();
  function* items() {
    yield 1;
    throw error;
  }
  const visit = jest.fn(() => gate.promise);
  const operation = forEachConcurrent(items(), visit, { concurrency: 2 });
  const rejected = expect(operation).rejects.toBe(error);
  await flushWork();
  expect(visit).toHaveBeenCalledTimes(1);
  gate.resolve();
  await rejected;
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid concurrency %s without starting work',
  async (concurrency) => {
    const visit = jest.fn();
    await expect(
      forEachConcurrent([1], visit, { concurrency })
    ).rejects.toThrow(RangeError);
    expect(visit).not.toHaveBeenCalled();
  }
);

it('settles an empty iterable without starting work', async () => {
  const visit = jest.fn();
  await forEachConcurrent([], visit, { concurrency: 10 });
  expect(visit).not.toHaveBeenCalled();
});
