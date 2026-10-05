import { runCompetitionWorkerTasks } from './competition-worker-tasks';

it('continues legacy execution and durable delivery when native discovery fails', async () => {
  const unavailable = new Error('native table unavailable');
  const legacy = jest.fn(async () => undefined);
  const delivery = jest.fn(async () => undefined);
  await expect(
    runCompetitionWorkerTasks([
      async () => {
        throw unavailable;
      },
      legacy,
      delivery
    ])
  ).rejects.toBe(unavailable);
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(delivery).toHaveBeenCalledTimes(1);
});
