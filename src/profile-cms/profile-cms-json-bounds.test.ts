import { BadRequestException } from '@/exceptions';
import {
  assertCmsOwnerJsonBounded,
  CMS_OWNER_MAX_JSON_DEPTH,
  CMS_OWNER_MAX_JSON_NODES,
  findExceededJsonStructureLimit
} from '@/profile-cms/profile-cms-json-bounds';
import fc from 'fast-check';

function nestedArrays(depth: number): unknown {
  let value: unknown = [];
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

function nestedObjects(depth: number): unknown {
  let value: unknown = {};
  for (let index = 0; index < depth; index++) value = { child: value };
  return value;
}

function measure(input: unknown): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 }
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes++;
    depth = Math.max(depth, item.depth);
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return { nodes, depth };
}

describe('findExceededJsonStructureLimit', () => {
  it('accepts documents at the limits and reports the first exceeded one', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), (value) => {
        const { nodes, depth } = measure(value);
        expect(
          findExceededJsonStructureLimit(value, {
            maxNodes: nodes,
            maxDepth: depth
          })
        ).toBeNull();
        if (nodes > 1) {
          expect(
            findExceededJsonStructureLimit(value, {
              maxNodes: nodes - 1,
              maxDepth: depth
            })
          ).toBe('nodes');
        }
        if (depth > 0) {
          expect(
            findExceededJsonStructureLimit(value, {
              maxNodes: nodes,
              maxDepth: depth - 1
            })
          ).toBe('depth');
        }
      })
    );
  });

  it('walks very deep documents without recursion', () => {
    const limits = { maxNodes: Infinity, maxDepth: Infinity };
    expect(
      findExceededJsonStructureLimit(nestedArrays(200_000), limits)
    ).toBeNull();
    expect(
      findExceededJsonStructureLimit(nestedObjects(200_000), limits)
    ).toBeNull();
  });

  it('stops reading values once the node limit is passed', () => {
    let reads = 0;
    const wide = new Proxy(new Array<number>(1_000_000).fill(0), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      }
    });

    expect(
      findExceededJsonStructureLimit(wide, { maxNodes: 10, maxDepth: 10 })
    ).toBe('nodes');
    expect(reads).toBeLessThanOrEqual(10);
  });

  it('stops descending once the depth limit is passed', () => {
    let reads = 0;
    const deep = nestedObjects(10) as { child: unknown };
    let leaf = deep;
    while (Object.keys(leaf.child as object).length > 0) {
      leaf = leaf.child as { child: unknown };
    }
    Object.defineProperty(leaf.child, 'beyond', {
      enumerable: true,
      get: () => {
        reads++;
        return nestedObjects(1_000);
      }
    });

    expect(
      findExceededJsonStructureLimit(deep, { maxNodes: 100, maxDepth: 5 })
    ).toBe('depth');
    expect(reads).toBe(0);
  });

  it('passes every property name to the key callback', () => {
    const keys: string[] = [];
    findExceededJsonStructureLimit(
      { a: [{ b: 1 }], c: { d: null } },
      { maxNodes: 100, maxDepth: 10 },
      (key) => keys.push(key)
    );
    expect([...keys].sort((x, y) => x.localeCompare(y))).toEqual([
      'a',
      'b',
      'c',
      'd'
    ]);
  });
});

describe('assertCmsOwnerJsonBounded', () => {
  it('accepts a document within the owner limits', () => {
    const blocks = Array.from({ length: 1_000 }, (_, index) => ({
      id: `b${index}`,
      values: { text: 'gm', nested: [1, 2, 3] }
    }));
    expect(() =>
      assertCmsOwnerJsonBounded(
        { payload: { pages: [{ blocks }] } },
        'cms_package'
      )
    ).not.toThrow();
    expect(() =>
      assertCmsOwnerJsonBounded(
        nestedArrays(CMS_OWNER_MAX_JSON_DEPTH),
        'cms_package'
      )
    ).not.toThrow();
    expect(() =>
      assertCmsOwnerJsonBounded(
        new Array(CMS_OWNER_MAX_JSON_NODES - 1).fill(0),
        'cms_package'
      )
    ).not.toThrow();
  });

  it('rejects a document over the owner node limit', () => {
    expect(() =>
      assertCmsOwnerJsonBounded(
        new Array(CMS_OWNER_MAX_JSON_NODES).fill(0),
        'cms_package'
      )
    ).toThrow(
      new BadRequestException(
        `cms_package exceeds the maximum of ${CMS_OWNER_MAX_JSON_NODES} JSON values`
      )
    );
  });

  it.each([
    ['arrays', nestedArrays(CMS_OWNER_MAX_JSON_DEPTH + 1)],
    ['objects', nestedObjects(CMS_OWNER_MAX_JSON_DEPTH + 1)]
  ])('rejects deeply nested %s', (_, value) => {
    expect(() => assertCmsOwnerJsonBounded(value, 'agent_patch')).toThrow(
      new BadRequestException(
        `agent_patch exceeds the maximum nesting depth of ${CMS_OWNER_MAX_JSON_DEPTH}`
      )
    );
  });
});
