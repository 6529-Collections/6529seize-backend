export type DagEdge = readonly [string, string];

export type OrderedDag = {
  readonly order: string[];
  readonly dependants: ReadonlyMap<string, readonly string[]>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  readonly layers: readonly (readonly string[])[];
};

function sorted(values: Iterable<string>): string[] {
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

export function topologicallySort(
  nodes: readonly string[],
  edges: readonly DagEdge[],
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b)
): OrderedDag {
  const nodeSet = new Set(nodes);
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const dependants = new Map(nodes.map((node) => [node, new Set<string>()]));
  const dependencies = new Map(nodes.map((node) => [node, new Set<string>()]));

  for (const [dependency, dependant] of edges) {
    if (!nodeSet.has(dependency) || !nodeSet.has(dependant)) {
      throw new Error(
        `DAG edge references unknown node: ${dependency} -> ${dependant}`
      );
    }
    if (dependency === dependant) {
      throw new Error(`DAG cycle detected at ${dependency}`);
    }
    const children = dependants.get(dependency) as Set<string>;
    if (!children.has(dependant)) {
      children.add(dependant);
      (dependencies.get(dependant) as Set<string>).add(dependency);
      incoming.set(dependant, (incoming.get(dependant) ?? 0) + 1);
    }
  }

  const ready = nodes.filter((node) => incoming.get(node) === 0).sort(compare);
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as string;
    order.push(current);
    for (const dependant of sorted(dependants.get(current) ?? [])) {
      const remaining = (incoming.get(dependant) ?? 0) - 1;
      incoming.set(dependant, remaining);
      if (remaining === 0) {
        ready.push(dependant);
        ready.sort(compare);
      }
    }
  }

  if (order.length !== nodeSet.size) {
    const cyclic = sorted(
      Array.from(incoming.entries())
        .filter(([, count]) => count > 0)
        .map(([node]) => node)
    );
    throw new Error(`DAG cycle detected: ${cyclic.join(', ')}`);
  }

  const resolved = new Set<string>();
  const remaining = new Set(nodes);
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = Array.from(remaining)
      .filter((node) =>
        Array.from(dependencies.get(node) ?? []).every((dependency) =>
          resolved.has(dependency)
        )
      )
      .sort(compare);
    if (layer.length === 0) {
      throw new Error('DAG cycle detected while computing dependency layers');
    }
    layers.push(layer);
    for (const node of layer) {
      remaining.delete(node);
      resolved.add(node);
    }
  }

  return {
    order,
    dependants: new Map(
      Array.from(dependants.entries()).map(([node, children]) => [
        node,
        sorted(children)
      ])
    ),
    dependencies: new Map(
      Array.from(dependencies.entries()).map(([node, parents]) => [
        node,
        sorted(parents)
      ])
    ),
    layers
  };
}

export function transitiveDependants(
  roots: readonly string[],
  dependants: ReadonlyMap<string, readonly string[]>
): Set<string> {
  const held = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.shift() as string;
    for (const dependant of dependants.get(node) ?? []) {
      if (!held.has(dependant)) {
        held.add(dependant);
        pending.push(dependant);
      }
    }
  }
  return held;
}

export function isDependencyClosed(
  selected: ReadonlySet<string>,
  edges: readonly DagEdge[]
): boolean {
  return edges.every(
    ([dependency, dependant]) =>
      !selected.has(dependant) || selected.has(dependency)
  );
}
