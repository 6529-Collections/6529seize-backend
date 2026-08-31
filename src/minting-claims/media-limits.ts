export const MAX_MAIN_STAGE_MEDIA_BYTES = 250 * 1024 * 1024;

// Minting-claim inspection and publication must use the same ceiling enforced
// when media is attached to a Main Stage submission.
export const MAX_MINTING_CLAIM_MEDIA_BYTES = MAX_MAIN_STAGE_MEDIA_BYTES;
