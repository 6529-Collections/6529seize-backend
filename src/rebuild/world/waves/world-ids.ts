/**
 * The made-up ids of the waves area's world for the rebuild check: the
 * 6529.io ids of the two waves the chain world imports (their legacy ids
 * on the chain), their description drops, two chat drops and the
 * members-only wave's group.
 */
export const WAVES_WORLD_IDS = {
  publicWave: '00000000-0000-4000-8000-0000000000a2',
  membersWave: '00000000-0000-4000-8000-0000000000a1',
  /** A legacy rank wave with its competition (not on the chain world). */
  rankWave: '00000000-0000-4000-8000-0000000000a3',
  rankDescription: '00000000-0000-4000-8000-0000000001a3',
  /** The members-only wave's group (the chain world's first group). */
  group: '00000000-0000-4000-8000-000000000092',
  publicDescription: '00000000-0000-4000-8000-0000000001a2',
  membersDescription: '00000000-0000-4000-8000-0000000001a1',
  firstDrop: '00000000-0000-4000-8000-0000000002a2',
  secondDrop: '00000000-0000-4000-8000-0000000003a2'
} as const;
