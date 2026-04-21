export function isWaveCreatorOrAdmin({
  authenticatedProfileId,
  wave,
  groupIdsUserIsEligibleFor
}: {
  authenticatedProfileId: string | null | undefined;
  wave: {
    readonly created_by: string;
    readonly admin_group_id: string | null;
  };
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  return (
    (!!authenticatedProfileId && wave.created_by === authenticatedProfileId) ||
    (wave.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.admin_group_id))
  );
}
