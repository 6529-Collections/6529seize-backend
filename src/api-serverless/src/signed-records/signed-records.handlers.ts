import { ApiSignedRecordsAnchor } from '@/api/generated/models/ApiSignedRecordsAnchor';
import { ApiSignedRecordsOwners } from '@/api/generated/models/ApiSignedRecordsOwners';
import {
  GetSignedRecordsAnchorRequest,
  GetSignedRecordsOwnersRequest
} from '@/api/generated/routes/operations';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  ReadFailureLog,
  RecordAnchorService,
  recordAnchorService
} from '@/signed-records/record-anchor';
import { isWalletAddress } from '@/signed-records/record-families';
import { recordOwnerDirectory } from '@/signed-records/record-owner-directory';

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
const ownersFailures = new ReadFailureLog(
  Logger.get('SIGNED_RECORDS_OWNERS'),
  'OWNERS READ FAILED'
);

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
    ownersFailures.succeeded();
  } catch (error) {
    ownersFailures.failed(error);
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
