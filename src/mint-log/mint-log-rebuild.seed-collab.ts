import {
  MEME_COLLABORATION_INVITATIONS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { sqlExecutor } from '@/sql-executor';
import {
  PROBE_COLLAB_DROP,
  PROBE_MAIN_STAGE_WAVE
} from './mint-log-rebuild.ids';
import {
  insertDrop,
  insertWave,
  SEEDED_AT
} from './mint-log-rebuild.seed-rows';

/**
 * The rebuild check's collaboration on a Main Stage artwork: profile 1
 * submits it with profile 2 invited, profile 2 accepts. The invitation and
 * the reply go through the collaboration service, so the mint log records
 * them on the artwork's own sequence.
 *
 * The wave and the artwork drop are plain rows (mint-log-rebuild.seed-rows.ts).
 */

const MAIN_STAGE_DESCRIPTION_DROP = '00000000-0000-4000-8000-0000000000c2';

/** A profiles row for a probe profile, as the personal seed writes it. */
async function insertProfile(profileId: string, wallet: string): Promise<void> {
  await sqlExecutor.execute(
    `insert ignore into ${PROFILES_TABLE}
       (external_id, handle, normalised_handle, primary_wallet, created_at,
        created_by_wallet, classification)
     values (:profileId, :profileId, :profileId, :wallet, :createdAt, :wallet,
        'PSEUDONYM')`,
    { profileId, wallet, createdAt: new Date(SEEDED_AT) }
  );
}

function signedIn(n: number): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: PROBE_WALLETS[n - 1],
    authenticatedProfileId: probeProfileId(n),
    roleProfileId: null,
    activeProxyActions: []
  });
}

export async function seedCollaboration(): Promise<void> {
  const author = probeProfileId(1);
  const invitee = probeProfileId(2);
  for (let n = 1; n <= PROBE_WALLETS.length; n++) {
    await insertProfile(probeProfileId(n), PROBE_WALLETS[n - 1]);
  }
  await insertWave({
    id: PROBE_MAIN_STAGE_WAVE,
    createdBy: author,
    descriptionDropId: MAIN_STAGE_DESCRIPTION_DROP
  });
  await insertDrop({
    id: PROBE_COLLAB_DROP,
    waveId: PROBE_MAIN_STAGE_WAVE,
    authorId: author,
    createdAt: SEEDED_AT,
    dropType: DropType.PARTICIPATORY,
    content: 'A Main Stage artwork with a collaborator.'
  });

  await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    memeCollaborationsService.onWrite(
      {
        drop_id: null,
        wave_id: PROBE_MAIN_STAGE_WAVE,
        reply_to: null,
        title: 'Probe collaboration',
        parts: [
          {
            content: 'A Main Stage artwork with a collaborator.',
            quoted_drop: null,
            media: [
              {
                url: 'https://media.example/rebuild-probe/collaboration.png',
                mime_type: 'image/png'
              }
            ]
          }
        ],
        referenced_nfts: [],
        mentioned_users: [],
        mentioned_waves: [],
        metadata: [
          { data_key: 'memeName', data_value: 'Probe collaboration' },
          { data_key: 'artist', data_value: 'Probe artist' }
        ],
        author_identity: PROBE_WALLETS[0],
        author_id: author,
        drop_type: DropType.PARTICIPATORY,
        mentioned_groups: [],
        signature: null,
        is_additional_action_promised: null,
        collaborator_ids: [invitee]
      },
      PROBE_COLLAB_DROP,
      { connection, authenticationContext: signedIn(1) }
    )
  );

  const [collaboration] = await sqlExecutor.execute<{
    artwork_hash: string;
    terms_version: string;
  }>(
    `select artwork_hash, terms_version from ${MEME_COLLABORATIONS_TABLE}
     where drop_id = :dropId`,
    { dropId: PROBE_COLLAB_DROP }
  );
  const [invitation] = await sqlExecutor.execute<{ id: string }>(
    `select id from ${MEME_COLLABORATION_INVITATIONS_TABLE}
     where drop_id = :dropId and profile_id = :invitee`,
    { dropId: PROBE_COLLAB_DROP, invitee }
  );
  if (!collaboration || !invitation) {
    throw new Error('The collaboration seed wrote no invitation');
  }
  await memeCollaborationsService.respond(
    PROBE_COLLAB_DROP,
    invitation.id,
    {
      action: 'ACCEPT',
      artwork_hash: collaboration.artwork_hash,
      terms_version: collaboration.terms_version,
      artist_name: 'Probe collaborator'
    },
    signedIn(2),
    {}
  );
}
