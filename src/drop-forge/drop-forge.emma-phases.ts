export const MEME_EMMA_PHASES = ['Phase 0', 'Phase 1', 'Phase 2'] as const;

export function canonicalMemePhaseName(name: string): string | undefined {
  const match = /^(?:(?:phase|p)\s*)?([012])$/i.exec(name.trim());
  return match ? MEME_EMMA_PHASES[Number(match[1])] : undefined;
}
