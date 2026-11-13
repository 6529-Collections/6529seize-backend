import { JoinedWaveSnapshot } from '@/api/waves/joined-wave-snapshot';

/** Preserve frozen ID order while rechecking current visibility/membership. */
export async function readWaveSnapshotPage<T extends { id: string }>(
  snapshot: JoinedWaveSnapshot,
  start: number,
  loadVisible: (waveIds: string[]) => Promise<T[]>
): Promise<{ waves: T[]; offset: number }> {
  const waves: T[] = [];
  let offset = start;
  // Bound DB round-trips. Clients must follow a cursor even after an empty page.
  const scanEnd = Math.min(snapshot.waveIds.length, start + 500);
  while (offset < scanEnd && waves.length < snapshot.pageSize) {
    const waveIds = snapshot.waveIds.slice(
      offset,
      Math.min(scanEnd, offset + Math.max(50, snapshot.pageSize))
    );
    const entities = await loadVisible(waveIds);
    const byId = new Map(entities.map((wave) => [wave.id, wave]));
    for (const waveId of waveIds) {
      offset += 1;
      const wave = byId.get(waveId);
      if (wave) waves.push(wave);
      if (waves.length === snapshot.pageSize) break;
    }
  }
  return { waves, offset };
}
