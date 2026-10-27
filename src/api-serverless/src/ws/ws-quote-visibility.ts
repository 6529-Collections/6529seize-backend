import type { ApiDrop } from '@/api/generated/models/ApiDrop';
import type { ApiDropWithoutWave } from '@/api/generated/models/ApiDropWithoutWave';
import type { ApiQuotedDropResponse } from '@/api/generated/models/ApiQuotedDropResponse';

function collectQuotedDropIds(
  drop: ApiDrop | ApiDropWithoutWave,
  quotedDropIds: Set<string>
): Set<string> {
  for (const part of drop.parts ?? []) {
    const quotedDrop = part.quoted_drop;
    if (quotedDrop) {
      quotedDropIds.add(quotedDrop.drop_id);
      if (quotedDrop.drop) {
        collectQuotedDropIds(quotedDrop.drop, quotedDropIds);
      }
    }
  }
  if (drop.reply_to?.drop) {
    collectQuotedDropIds(drop.reply_to.drop, quotedDropIds);
  }
  return quotedDropIds;
}

function redactQuotedDropsInPlace(
  drop: ApiDrop | ApiDropWithoutWave,
  visibleQuotedDropIds: ReadonlySet<string>
): void {
  for (const part of drop.parts ?? []) {
    const quotedDrop = part.quoted_drop;
    if (!quotedDrop) {
      continue;
    }
    if (!visibleQuotedDropIds.has(quotedDrop.drop_id)) {
      const reference: ApiQuotedDropResponse & { is_deleted: boolean } = {
        drop_id: quotedDrop.drop_id,
        drop_part_id: quotedDrop.drop_part_id,
        is_deleted: false
      };
      part.quoted_drop = reference;
    } else if (quotedDrop.drop) {
      redactQuotedDropsInPlace(quotedDrop.drop, visibleQuotedDropIds);
    }
  }
  if (drop.reply_to?.drop) {
    redactQuotedDropsInPlace(drop.reply_to.drop, visibleQuotedDropIds);
  }
}

export function getQuotedDropIds(drop: ApiDrop): string[] {
  return Array.from(collectQuotedDropIds(drop, new Set<string>()));
}

/**
 * Websocket payloads are built once and fanned out to the whole wave audience,
 * so a quote stays embedded only when that entire audience can read it. Other
 * quotes keep their reference and clients resolve them with their own access.
 */
export function redactQuotedDropsOutsideAudience(
  inputDrop: ApiDrop,
  visibleQuotedDropIds: ReadonlySet<string>
): ApiDrop {
  if (
    getQuotedDropIds(inputDrop).every((dropId) =>
      visibleQuotedDropIds.has(dropId)
    )
  ) {
    return inputDrop;
  }
  const audienceDrop = structuredClone(inputDrop);
  redactQuotedDropsInPlace(audienceDrop, visibleQuotedDropIds);
  return audienceDrop;
}
