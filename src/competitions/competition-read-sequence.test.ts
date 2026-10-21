import { readSequentially } from '@/competitions/competition-read-sequence';

it('waits for the current read before starting the next read', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const result = readSequentially([1, 2], async (value) => {
    events.push(`start-${value}`);
    if (value === 1) await gate;
    events.push(`end-${value}`);
  });
  await Promise.resolve();
  expect(events).toEqual(['start-1']);
  release();
  await result;
  expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
});

it('does not start another read after a failed page', async () => {
  const read = jest.fn().mockRejectedValue(new Error('closed transaction'));
  await expect(readSequentially([1, 2, 3], read)).rejects.toThrow(
    'closed transaction'
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(1);
});
