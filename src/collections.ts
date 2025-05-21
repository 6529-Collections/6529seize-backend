export function getMapWithKeysAndValuesSwitched(
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
