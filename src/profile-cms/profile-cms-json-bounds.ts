import { BadRequestException } from '@/exceptions';

/**
 * Structural limits for CMS package JSON submitted on the owner routes
 * (draft save, package validation and patch validation). They are deliberately
 * generous: a real site stays far below them, and the 5 MB request body limit
 * still applies on top.
 */
export const CMS_OWNER_MAX_JSON_NODES = 250_000;
export const CMS_OWNER_MAX_JSON_DEPTH = 64;

export interface JsonStructureLimits {
  /** Maximum number of values in the document, the root included. */
  readonly maxNodes: number;
  /** Maximum nesting depth; the root is at depth 0. */
  readonly maxDepth: number;
}

export type JsonStructureLimit = 'nodes' | 'depth';

/**
 * Walks a parsed JSON value with an explicit stack (no recursion) and returns
 * the first limit it exceeds, or null when it stays within both. Values are
 * counted as they are discovered, so the walk stops as soon as a limit is
 * passed. `onKey` is called with each own property name of every object
 * visited and may throw to reject the document.
 */
export function findExceededJsonStructureLimit(
  input: unknown,
  limits: JsonStructureLimits,
  onKey?: (key: string) => void
): JsonStructureLimit | null {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 }
  ];
  let nodes = 1;
  if (nodes > limits.maxNodes) return 'nodes';
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (!value || typeof value !== 'object') continue;
    const childDepth = depth + 1;
    const isArray = Array.isArray(value);
    const keys = isArray ? null : Object.keys(value);
    const count = keys ? keys.length : (value as unknown[]).length;
    for (let index = 0; index < count; index++) {
      if (++nodes > limits.maxNodes) return 'nodes';
      if (childDepth > limits.maxDepth) return 'depth';
      let child: unknown;
      if (keys) {
        const key = keys[index];
        onKey?.(key);
        child = (value as Record<string, unknown>)[key];
      } else {
        child = (value as unknown[])[index];
      }
      stack.push({ value: child, depth: childDepth });
    }
  }
  return null;
}

/**
 * Rejects an owner-route CMS request value that exceeds the owner node or
 * depth limit, before it is parsed with the package schema. Not applied to
 * packages read back from storage.
 */
export function assertCmsOwnerJsonBounded(
  input: unknown,
  fieldName: string
): void {
  const exceeded = findExceededJsonStructureLimit(input, {
    maxNodes: CMS_OWNER_MAX_JSON_NODES,
    maxDepth: CMS_OWNER_MAX_JSON_DEPTH
  });
  if (exceeded === 'nodes') {
    throw new BadRequestException(
      `${fieldName} exceeds the maximum of ${CMS_OWNER_MAX_JSON_NODES} JSON values`
    );
  }
  if (exceeded === 'depth') {
    throw new BadRequestException(
      `${fieldName} exceeds the maximum nesting depth of ${CMS_OWNER_MAX_JSON_DEPTH}`
    );
  }
}
