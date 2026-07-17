import { env } from '@/env';

/**
 * Latest moment (epoch millis) a drop can still be edited by its author, or
 * null when editing is not available at all. Mirrors the guard in
 * CreateOrUpdateDropUseCase: edits are allowed for MAX_DROP_EDIT_TIME_MS
 * after the drop was last touched, and a missing/zero window means editing
 * is disabled. Exposed on API drops so clients can hide edit affordances
 * instead of letting users compose an edit that the API will reject.
 */
export function getDropEditableUntil({
  createdAt,
  updatedAt
}: {
  readonly createdAt: number;
  readonly updatedAt: number | null;
}): number | null {
  const editWindowMs = env.getIntOrNull('MAX_DROP_EDIT_TIME_MS') ?? 0;
  if (editWindowMs <= 0) {
    return null;
  }
  return (updatedAt ?? createdAt) + editWindowMs;
}
