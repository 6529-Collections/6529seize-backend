import { CompetitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { validateCollaborationInvitees } from '@/meme-collaborations/meme-collaboration-invitation-policy';
import { MemeCollaborationsDb } from '@/meme-collaborations/meme-collaborations.db';
import { collaborationArtworkHash } from '@/meme-collaborations/meme-collaborations.service';
import { writerPoolExecutor } from './waves-chain-mirror.writer';

/**
 * The checks 6529.io's collaboration write (MemeCollaborationsService
 * onWrite) makes when a new entry drop is written, made before the
 * decision's transaction. An entry made on the chain can pass every check
 * of the mirror's own and still be refused there: collaborators on an
 * entry that isn't an artwork (no memeName, or no media), Memes artwork
 * whose additional_media isn't JSON, an author or collaborator with no
 * profile. Refused inside the transaction, the whole decision would fail
 * every run; refused here, only that entry is held back, with its reason.
 */

/** What the checks read. */
export interface CollaborationReads {
  /** Whether the competition is the designated Main Stage. */
  isMainStage(competitionId: string): Promise<boolean>;
  /** The profiles rows of these ids (a missing or handle-less one fails). */
  profiles(ids: string[]): Promise<{ id: string; handle: string | null }[]>;
}

const mainStage = new CompetitionMainStageRepository(() => writerPoolExecutor);
const collaborationsDb = new MemeCollaborationsDb(() => writerPoolExecutor);

export const collaborationReads: CollaborationReads = {
  isMainStage: (competitionId) => mainStage.isDesignated(competitionId, {}),
  profiles: (ids) => collaborationsDb.profiles(ids, {})
};

export type CollaborationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      /** A profile may appear later: asked again, waiting longer each time. */
      readonly delay: boolean;
    };

const refused = (reason: string): CollaborationCheck => ({
  ok: false,
  reason,
  delay: false
});

/**
 * Whether the collaboration write would take a new entry drop, by its
 * checks in its order: an artwork submission (a participatory or
 * competition drop with memeName metadata and media) or no invitations;
 * distinct invitees other than the author; invitations only on the Main
 * Stage; the artwork's details readable; every artist with a profile and a
 * handle.
 */
export async function collaborationCheck(
  model: CreateOrUpdateDropModel,
  competitionId: string,
  reads: CollaborationReads
): Promise<CollaborationCheck> {
  const ids = model.collaborator_ids;
  const artworkSubmission =
    [DropType.PARTICIPATORY, DropType.COMPETITION].includes(model.drop_type) &&
    model.metadata.some((item) => item.data_key === 'memeName') &&
    model.parts.some((part) => part.media.length);
  if (!artworkSubmission) {
    return ids === undefined
      ? { ok: true }
      : refused('collaboration_not_artwork');
  }
  const invitees = ids ?? [];
  try {
    validateCollaborationInvitees(invitees, model.author_id!);
  } catch {
    return refused('collaboration_invitees');
  }
  if (!(await reads.isMainStage(competitionId))) {
    return invitees.length
      ? refused('collaboration_outside_main_stage')
      : { ok: true };
  }
  try {
    collaborationArtworkHash(model);
  } catch {
    return refused('collaboration_artwork_metadata');
  }
  const profiles = await reads.profiles([model.author_id!, ...invitees]);
  if (
    profiles.length !== invitees.length + 1 ||
    profiles.some((profile) => !profile.handle)
  ) {
    return { ok: false, reason: 'collaboration_profile_missing', delay: true };
  }
  return { ok: true };
}
