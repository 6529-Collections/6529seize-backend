import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROPS_TABLE,
  MEME_CARD_DROP_MAPPINGS_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIMS_TABLE
} from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import * as safeFetch from '@/http/safe-fetch';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import { mintingClaimsDb } from '@/minting-claims/minting-claims.db';
import { MintingClaimsService } from '@/minting-claims/minting-claims.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import type { ClaimBuildMessage } from '@/waves-chain-index/waves-chain-index.claims';
import {
  nativeEntryRowId,
  resultDecisionId
} from '@/waves-chain-mirror/waves-chain-mirror.ids';
import { buildClaimLogged, parseChainClaimContext } from './mint-claim-build';
import type { MintChainDecisionResult, MintGatewayPort } from './mint-gateway';
import { MintLogRecorder } from './mint-log-recorder';

/**
 * The claims builder's side of a Main Stage winner entered on the chain:
 * its drop is the one the chain mirror writes, with the chain entry id as
 * its id (0x and 64 hex digits, not a UUID), and the index's message names
 * that drop and the result. Made-up rows only. The gateway is a fake port,
 * and the media inspection's fetch is the one call replaced.
 */

const chainId = (n: string) => `0x${n.padStart(64, '0')}`;
const D = chainId('d1');
const EN = chainId('e8');
const MANIFEST = chainId('5e8');
const WAVE = '00000000-0000-4000-8000-0000000000a0';
const COMPETITION = legacyCompetitionId(WAVE);
const T1 = 1_764_600_000_000;
const HEIGHT = 40;
// The rows the chain mirror writes for the winner (waves-chain-mirror.ids.ts).
const ENTRY = nativeEntryRowId(COMPETITION, EN);
const DECISION = resultDecisionId(COMPETITION, T1);
const AUTHOR = 'chain-entry-author';
const MEDIA_URL = 'https://media.example.test/chain-entry.png';
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const wave = aWave({}, { id: WAVE, name: 'Main Stage', serial_no: 1 });

/** What the index sends for the result, as the claims builder reads it. */
const MESSAGE: ClaimBuildMessage = {
  drop_id: EN,
  chain: {
    decision_id: D,
    occurrence: 3,
    entry_id: EN,
    height: HEIGHT,
    manifest_hash: MANIFEST
  }
};

/** The gateway's answer: occurrence 3 final, the entry first with its manifest. */
const FINAL: MintChainDecisionResult = {
  decision_id: D,
  occurrence: 3,
  state: 'FINAL',
  height: 45,
  winners: [{ rank: 1, entry_id: EN, manifest_hash: MANIFEST }]
};

function jsonOf(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

describeWithSeed(
  'buildClaimLogged: a Main Stage winner entered on the chain',
  [
    withWaves([wave]),
    { table: COMPETITIONS_TABLE, rows: [nativeOriginalPrimaryFixture(wave)] },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [
        {
          competition_id: COMPETITION,
          wave_id: WAVE,
          capability: 'MAIN_STAGE',
          assigned_at: 1
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: EN,
          wave_id: WAVE,
          author_id: AUTHOR,
          created_at: T1 - 86_400_000,
          title: null,
          parts_count: 1,
          drop_type: DropType.COMPETITION
        }
      ]
    },
    {
      table: DROP_MEDIA_TABLE,
      rows: [
        {
          drop_id: EN,
          drop_part_id: 1,
          url: MEDIA_URL,
          mime_type: 'image/png',
          wave_id: WAVE
        }
      ]
    },
    {
      table: DROP_METADATA_TABLE,
      rows: [
        ['title', 'A card entered on the chain'],
        ['description', 'Made up for this test.'],
        ['artist', 'A made-up artist']
      ].map(([data_key, data_value]) => ({
        drop_id: EN,
        data_key,
        data_value,
        wave_id: WAVE
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: ENTRY,
          competition_id: COMPETITION,
          wave_id: WAVE,
          drop_id: EN,
          submitter_id: AUTHOR,
          status: 'WINNER',
          config_version: 1,
          submitted_at: T1 - 86_400_000,
          won_at: T1,
          rank: 1,
          decision_id: DECISION
        }
      ]
    },
    {
      table: COMPETITION_DECISION_WINNERS_TABLE,
      rows: [
        {
          competition_id: COMPETITION,
          entry_id: ENTRY,
          decision_id: DECISION,
          rank: 1,
          final_rating: 9,
          created_at: T1
        }
      ]
    }
  ],
  () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** The claims builder's own dependencies; the mint log's flags off. */
    function deps(gateway: MintGatewayPort) {
      return {
        recorder: new MintLogRecorder({
          isMintLogShadowEnabled: () => false,
          isMintLogPrimaryEnabled: () => false,
          isMintLogReplayCheckEnabled: () => false
        }),
        claims: new MintingClaimsService(
          dropsDb,
          mintingClaimsDb,
          memeCardDropMappingsDb,
          () => WAVE
        ),
        gateway,
        mainStage: [D]
      };
    }

    /** The message off the queue, as the claims builder's handler reads it. */
    async function build(gateway: MintGatewayPort) {
      const body = JSON.parse(JSON.stringify(MESSAGE)) as ClaimBuildMessage;
      await buildClaimLogged(
        { dropId: body.drop_id, chain: parseChainClaimContext(body.chain) },
        deps(gateway)
      );
    }

    it("builds the claim for the drop whose id is the chain entry's, and maps the card to it, once", async () => {
      // The media inspection's fetch: the drop's image, nothing else.
      const fetched = jest
        .spyOn(safeFetch, 'fetchPublicUrlToBuffer')
        .mockImplementation(async (url) => {
          if (url !== MEDIA_URL) throw new Error(`unexpected fetch: ${url}`);
          return { buffer: PNG, contentType: 'image/png', finalUrl: url };
        });
      const gateway = { decisionResult: jest.fn().mockResolvedValue(FINAL) };

      await build(gateway);

      expect(gateway.decisionResult).toHaveBeenCalledWith(D, 3);
      expect(fetched).toHaveBeenCalledWith(MEDIA_URL, expect.anything());
      const claims = await sqlExecutor.execute<Record<string, unknown>>(
        `select drop_id, contract, claim_id, name, description, image_url,
                image_details, attributes
           from ${MINTING_CLAIMS_TABLE}`
      );
      // No claim and no meme yet: claim 1, in the calendar's season 1.
      expect(
        claims.map((claim) => ({
          ...claim,
          image_details: jsonOf(claim.image_details),
          attributes: jsonOf(claim.attributes)
        }))
      ).toEqual([
        {
          drop_id: EN,
          contract: MEMES_CONTRACT.toLowerCase(),
          claim_id: 1,
          name: 'A card entered on the chain',
          description: 'Made up for this test.',
          image_url: MEDIA_URL,
          image_details: {
            bytes: PNG.length,
            format: 'PNG',
            sha256: createHash('sha256').update(PNG).digest('hex'),
            width: 1,
            height: 1
          },
          attributes: [
            { trait_type: 'Artist', value: 'A made-up artist' },
            { trait_type: 'Type - Season', value: 1, display_type: 'number' }
          ]
        }
      ]);
      const mapping = [{ meme_card_id: 1, drop_id: EN }];
      expect(
        await sqlExecutor.execute(
          `select meme_card_id, drop_id from ${MEME_CARD_DROP_MAPPINGS_TABLE}`
        )
      ).toEqual(mapping);

      // The index sends a message again after a run that stopped between
      // its send and the row's update: nothing more is built.
      await build(gateway);
      expect(
        await sqlExecutor.execute(
          `select drop_id, claim_id from ${MINTING_CLAIMS_TABLE}`
        )
      ).toEqual([{ drop_id: EN, claim_id: 1 }]);
      expect(
        await sqlExecutor.execute(
          `select meme_card_id, drop_id from ${MEME_CARD_DROP_MAPPINGS_TABLE}`
        )
      ).toEqual(mapping);
      expect(fetched).toHaveBeenCalledTimes(1);
    });
  }
);
