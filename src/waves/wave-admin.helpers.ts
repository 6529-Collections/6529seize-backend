export function isWaveCreatorOrAdmin({
  authenticatedProfileId,
  wave,
  groupIdsUserIsEligibleFor
}: {
  authenticatedProfileId: string | null | undefined;
  wave: {
    readonly created_by: string;
    readonly admin_group_id: string | null;
    readonly visibility_group_id?: string | null | undefined;
  };
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  if (
    wave.visibility_group_id &&
    !groupIdsUserIsEligibleFor.includes(wave.visibility_group_id)
  ) {
    return false;
  }
  return (
    (!!authenticatedProfileId && wave.created_by === authenticatedProfileId) ||
    (wave.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.admin_group_id))
  );
}
