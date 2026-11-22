import { ApiSignedRecordsAnchor } from '@/api/generated/models/ApiSignedRecordsAnchor';
import { ApiSignedRecordsOwners } from '@/api/generated/models/ApiSignedRecordsOwners';
import {
  GetSignedRecordsAnchorRequest,
  GetSignedRecordsModeRequest,
  GetSignedRecordsOwnersRequest,
  SubmitSignedRecordsRequest
} from '@/api/generated/routes/operations';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import {
  RecordAnchorService,
  recordAnchorService
} from '@/signed-records/record-anchor';
import { isWalletAddress } from '@/signed-records/record-families';
import { recordOwnerDirectory } from '@/signed-records/record-owner-directory';
import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiSignedRecordsMode } from '@/api/generated/models/ApiSignedRecordsMode';
import { ApiSubmitSignedRecordsRequest } from '@/api/generated/models/ApiSubmitSignedRecordsRequest';
import { ApiSubmitSignedRecordsResponse } from '@/api/generated/models/ApiSubmitSignedRecordsResponse';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import * as Joi from 'joi';
import {
  personalProviderKeys,
  personalRecordsService
} from '@/personal-records/personal-records';
import {
  assertRecordsWrite,
  personalRecordsMode
} from '@/personal-records/personal-records.mode';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';
import { PERSONAL_SUBMIT_MAX_EVENTS } from '@/personal-records/personal-records.service';
import { Timer } from '@/time';

/** GET /signed-records/anchor: the height to sign as a record's anchor. */
export async function handleGetSignedRecordsAnchor(
  _req: GetSignedRecordsAnchorRequest,
  service: RecordAnchorService = recordAnchorService
): Promise<ApiSignedRecordsAnchor> {
  const anchor = await service.getAnchor();
  return {
    anchor: anchor.anchor,
    head_height: anchor.headHeight,
    finalized_time: anchor.finalizedTime,
    max_anchor_lag: anchor.maxAnchorLag
  };
}

const OWNERS_MAX_WALLETS = 50;

/** GET /signed-records/owners: the owner each wallet's records use. */
export async function handleGetSignedRecordsOwners(
  req: GetSignedRecordsOwnersRequest
): Promise<ApiSignedRecordsOwners> {
  const wallets = Array.from(
    new Set(
      String(req.query.wallets ?? '')
        .split(',')
        .map((wallet) => wallet.trim().toLowerCase())
        .filter((wallet) => wallet.length > 0)
    )
  );
  if (
    wallets.length === 0 ||
    wallets.length > OWNERS_MAX_WALLETS ||
    wallets.some((wallet) => !isWalletAddress(wallet))
  ) {
    throw new BadRequestException(
      `Send 1 to ${OWNERS_MAX_WALLETS} wallets, 0x and 40 hex digits each`
    );
  }
  if (!recordOwnerDirectory.hasChain()) {
    throw new CustomApiCompliantException(
      503,
      'The chain gateway is not configured, so wallets have no owners yet',
      'OWNERS_UNAVAILABLE'
    );
  }
  const { anchor } = await recordAnchorService.getAnchor();
  let owners: Map<string, string>;
  try {
    owners = await recordOwnerDirectory.ownersAt(wallets, anchor);
  } catch {
    throw new CustomApiCompliantException(
      503,
      'The chain gateway did not answer, so wallets have no owners yet',
      'OWNERS_UNAVAILABLE'
    );
  }
  return {
    anchor,
    owners: wallets.map((wallet) => {
      const owner = owners.get(wallet);
      if (!owner) {
        throw new CustomApiCompliantException(
          503,
          'The chain gateway named no owner for a wallet',
          'OWNERS_UNAVAILABLE'
        );
      }
      return { wallet, owner };
    })
  };
}

/** The wallet 6529.io reads pv streams as (env SIGNED_RECORDS_SITE_READER). */
function siteReaderWallet(): string | null {
  const wallet = process.env.SIGNED_RECORDS_SITE_READER?.trim().toLowerCase();
  return wallet && isWalletAddress(wallet) ? wallet : null;
}

/** GET /signed-records/mode */
export async function handleGetSignedRecordsMode(
  req: GetSignedRecordsModeRequest
): Promise<ApiSignedRecordsMode> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const wallet = authenticationContext.authenticatedWallet?.toLowerCase();
  let owner: string | null = null;
  if (wallet) {
    try {
      const { anchor } = await recordAnchorService.getAnchor();
      owner = await recordOwnerDirectory.ownerAt(wallet, anchor);
    } catch {
      // No gateway, no owner: the client cannot sign records until it is back.
      owner = null;
    }
  }
  return {
    mode: personalRecordsMode(),
    frozen: (await personalRecordsStateDb.read()).frozen,
    owner,
    site_reader: siteReaderWallet(),
    provider_keys: personalProviderKeys().map((key) => ({
      id: key.id,
      public_key: `0x${key.publicKey.toString('hex')}`
    }))
  };
}

const submitSchema = Joi.object<ApiSubmitSignedRecordsRequest>({
  events: Joi.array()
    .items(Joi.object().unknown(true))
    .min(1)
    .max(PERSONAL_SUBMIT_MAX_EVENTS)
    .required(),
  companion: Joi.boolean().optional()
});

/** POST /signed-records */
export async function handleSubmitSignedRecords(
  req: SubmitSignedRecordsRequest
): Promise<ApiSubmitSignedRecordsResponse> {
  const { events, companion } = getValidatedByJoiOrThrow(
    req.body as ApiSubmitSignedRecordsRequest,
    submitSchema
  );
  const mode = await assertRecordsWrite(
    personalRecordsStateDb,
    companion === true
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw new ForbiddenException(
      'You need a profile before you can save settings'
    );
  }
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException('Proxies cannot change settings');
  }
  const results = await personalRecordsService.submit(events, mode, profileId, {
    timer,
    authenticationContext
  });
  return { mode, results: [...results] };
}
