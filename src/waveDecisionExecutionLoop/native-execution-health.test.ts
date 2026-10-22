jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { reportLoopHealth } from '@/loop-health';
import { NativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';

it('keeps handled per-competition failures pending despite a successful worker return', async () => {
  const repository = {
    discoverCompetitions: jest
      .fn()
      .mockResolvedValueOnce(['a', 'b'])
      .mockResolvedValueOnce([])
  };
  const service = new NativeCompetitionRuntimeService(
    repository as never,
    {} as never,
    {} as never
  );
  const process = jest
    .spyOn(service, 'processCompetition')
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(undefined);
  await expect(service.processDueCompetitions()).resolves.toBeUndefined();
  expect(process).toHaveBeenCalledTimes(2);
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: 'native_execution', pending: true })
  );
});
