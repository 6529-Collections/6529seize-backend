import {
  CollectingWorkBudget,
  CollectingWorkTimeout
} from './collecting-work-budget';

it('shares elapsed time with a child and reserves time for persistence', () => {
  let elapsed = 0;
  const budget = new CollectingWorkBudget(20, () => elapsed);
  elapsed = 12;
  const child = budget.child(10, 3);
  expect(child.remainingMs()).toBe(5);
  elapsed = 17;
  expect(child.expired()).toBe(true);
  expect(budget.remainingMs()).toBe(3);
});

it('does not start work after its deadline', async () => {
  const work = jest.fn();
  await expect(
    new CollectingWorkBudget(0).waitFor(work)
  ).rejects.toBeInstanceOf(CollectingWorkTimeout);
  expect(work).not.toHaveBeenCalled();
});

it('bounds a stalled read without advancing timers or claiming cancellation', async () => {
  const budget = new CollectingWorkBudget(5);
  await expect(
    budget.waitFor(() => new Promise(() => {}))
  ).rejects.toBeInstanceOf(CollectingWorkTimeout);
});

it('rejects a late read before the caller can parse or persist its value', async () => {
  let elapsed = 0;
  let finish: (value: string) => void = () => {};
  const read = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const parse = jest.fn();
  const budget = new CollectingWorkBudget(10, () => elapsed);
  const result = budget.waitFor(() => read).then(parse);
  await Promise.resolve();
  elapsed = 11;
  finish('late');
  await expect(result).rejects.toBeInstanceOf(CollectingWorkTimeout);
  expect(parse).not.toHaveBeenCalled();
});

it('checks elapsed synchronous work after a resolved read', async () => {
  let elapsed = 0;
  const budget = new CollectingWorkBudget(10, () => elapsed);
  await expect(
    budget.waitFor(async () => {
      elapsed = 11;
      return 'late';
    })
  ).rejects.toBeInstanceOf(CollectingWorkTimeout);
});
