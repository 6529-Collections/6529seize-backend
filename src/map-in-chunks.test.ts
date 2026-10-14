import { mapInChunks } from '@/map-in-chunks';

function tracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: number[] = [];
  const fn = async (item: number) => {
    calls.push(item);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (item % 3) + 1));
    inFlight--;
    if (item < 0) {
      throw new Error(`item ${item} failed`);
    }
    return item * 10;
  };
  return { fn, calls, maxInFlight: () => maxInFlight };
}

describe('mapInChunks', () => {
  it('keeps input order with at most size calls in flight', async () => {
    const t = tracker();
    const items = Array.from({ length: 12 }, (_, i) => i);

    await expect(mapInChunks(items, 5, t.fn)).resolves.toEqual(
      items.map((i) => i * 10)
    );
    expect(t.maxInFlight()).toBe(5);
  });

  it('is strictly sequential with size 1', async () => {
    const t = tracker();

    await expect(mapInChunks([3, 1, 2], 1, t.fn)).resolves.toEqual([
      30, 10, 20
    ]);
    expect(t.maxInFlight()).toBe(1);
    expect(t.calls).toEqual([3, 1, 2]);
  });

  it('rejects with the first failure and starts no later chunk', async () => {
    const t = tracker();

    await expect(mapInChunks([1, -2, 3, 4], 2, t.fn)).rejects.toThrow(
      'item -2 failed'
    );
    expect(t.calls).toEqual([1, -2]);
  });

  it('handles an empty list and rejects a size below 1', async () => {
    await expect(mapInChunks([], 3, async (x: number) => x)).resolves.toEqual(
      []
    );
    await expect(mapInChunks([1], 0, async (x: number) => x)).rejects.toThrow(
      'size must be at least 1'
    );
  });
});
