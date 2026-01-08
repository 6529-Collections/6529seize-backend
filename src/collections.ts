export class Collections {
  public getMapWithKeysAndValuesSwitched(
    map: Map<string, string>
  ): Map<string, string[]> {
    return Array.from(map, ([name, value]) => ({ k: name, v: value })).reduce(
      (acc, { k, v }) => {
        if (!acc.has(v)) {
          acc.set(v, []);
        }
        acc.get(v)!.push(k);
        return acc;
      },
      new Map<string, string[]>()
    );
  }

  public chunkArray<T>(items: T[], size: number): T[][] {
    if (size <= 0) {
      throw new RangeError('size must be greater than 0');
    }

    const batchSize = Math.floor(size);
    const batched: T[][] = [];

    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize);
      batched.push(batch);
    }

    return batched;
  }

  public distinct<T>(arr: T[]): T[] {
    return Array.from(this.toSet(arr));
  }

  public toSet<T>(arr: T[]): Set<T> {
    return new Set(arr);
  }
}

export const collections = new Collections();
