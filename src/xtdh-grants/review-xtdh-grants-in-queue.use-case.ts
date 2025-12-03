import { RequestContext } from '../request.context';
import { Time, Timer } from '../time';
import {
  xTdhGrantsRepository,
  XTdhGrantsRepository
} from './xtdh-grants.repository';
import {
  externalIndexingRepository,
  ExternalIndexingRepository
} from '../external-indexing/external-indexing.repository';
import { Logger } from '../logging';
import { XTdhGrantEntity, XTdhGrantStatus } from '../entities/IXTdhGrant';
import { IndexedContractStatus } from '../entities/IExternalIndexedContract';
import { identitiesDb, IdentitiesDb } from '../identities/identities.db';
import { assertUnreachable } from '../assertions';

const GRANT_VALIDATION_FAILED_CODE = 'GRANT_VALIDATION_DENIED';

class GrantValidationDenied extends Error {
  private readonly code = GRANT_VALIDATION_FAILED_CODE;
}

export class ReviewXTdhGrantsInQueueUseCase {
  private readonly logger = Logger.get(this.constructor.name);
  constructor(
    private readonly xTdhGrantsRepository: XTdhGrantsRepository,
    private readonly externalIndexingRepository: ExternalIndexingRepository,
    private readonly identityRepository: IdentitiesDb
  ) {}

  public async handle(ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->handle`);
    const timer = ctx.timer ?? new Timer(`${this.constructor.name}->handle`);
    this.logger.info(
      `Starting to check if there are any pending grants in the queue`
    );
    const loopTimeout = Time.minutes(10);
    try {
      const seenGrants = new Set<string>();
      let tryMoreCandidates = true;
      do {
        const thereIsMoreTime = timer.getTotalTimePassed().lt(loopTimeout);
        tryMoreCandidates =
          thereIsMoreTime &&
          (await this.xTdhGrantsRepository.executeNativeQueriesInTransaction(
            async (connection) => {
              return await this.attemptOneGrantVerification(seenGrants, {
                ...ctx,
                connection
              });
            }
          ));
      } while (tryMoreCandidates);

      this.logger.info(`Stopping to look for pending grants in the queue`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }

  private async attemptOneGrantVerification(
    seenGrants: Set<string>,
    ctx: RequestContext
  ): Promise<boolean> {
    const grantCandidate =
      await this.xTdhGrantsRepository.lockOldestPendingGrant(ctx);
    if (!grantCandidate) {
      this.logger.info(`Found no pending grants in the queue`);
      return false;
    }
    const grantId = grantCandidate.id;
    this.logger.info(`Found a pending grant in the queue`, {
      id: grantId
    });
    if (seenGrants.has(grantId)) {
      this.logger.info(`Found reoccurring grant in queue. Will stop for now.`);
      return false;
    }
    seenGrants.add(grantId);
    const now = Time.currentMillis();
    try {
      const grantCandidateEnd = grantCandidate.valid_to
        ? Time.millis(grantCandidate.valid_to)
        : null;
      if (grantCandidateEnd?.isInPast()) {
        throw new GrantValidationDenied('Grant validation end is in the past');
      }
      const collectionInfo =
        await this.externalIndexingRepository.findCollectionInfo(
          {
            partition: grantCandidate.target_partition
          },
          ctx
        );
      if (!collectionInfo) {
        throw new GrantValidationDenied('Collection not indexed');
      }
      const indexingStatus = collectionInfo.status;
      switch (indexingStatus) {
        case IndexedContractStatus.ERROR_SNAPSHOTTING:
        case IndexedContractStatus.UNINDEXABLE: {
          throw new GrantValidationDenied(
            `Collection indexing failed. ${collectionInfo.error_message ?? ''}`
          );
        }
        case IndexedContractStatus.WAITING_FOR_SNAPSHOTTING:
        case IndexedContractStatus.SNAPSHOTTING: {
          await this.updateWithStillPending({ grantId }, ctx);
          break;
        }
        case IndexedContractStatus.LIVE_TAILING: {
          const missingToken = await this.searchForMissingToken(
            grantCandidate,
            ctx
          );
          if (missingToken) {
            throw new GrantValidationDenied(
              `One or more of the tokens in the do not actually exist in the collection. Example: ${missingToken}`
            );
          }
          const grantOverflow = await this.isGrantOverflowing(
            { grant: grantCandidate, now },
            ctx
          );
          if (grantOverflow) {
            throw new GrantValidationDenied(
              `Grant too large. Not enough capacity in grantors TDH Rate`
            );
          }
          await this.approveGrant(
            {
              grantId,
              validFrom: grantCandidate.valid_from ?? Time.currentMillis()
            },
            ctx
          );
          break;
        }
        default:
          assertUnreachable(indexingStatus);
      }
    } catch (e: any) {
      if (e.code === GRANT_VALIDATION_FAILED_CODE) {
        await this.xTdhGrantsRepository.updateStatus(
          {
            grantId: grantId,
            status: XTdhGrantStatus.FAILED,
            error: e.message
          },
          ctx
        );
      } else {
        throw e;
      }
    }
    return true;
  }

  private async isGrantOverflowing(
    { grant, now }: { grant: XTdhGrantEntity; now: number },
    ctxWithConnection: RequestContext
  ) {
    const [grantorsTotalRate, grantorsSpentRate] = await Promise.all([
      this.identityRepository.getProducedXTdhRate(
        grant.grantor_id,
        ctxWithConnection
      ),
      this.xTdhGrantsRepository.getGrantorsMaxSpentTdhRateInTimeSpan(
        {
          grantorId: grant.grantor_id,
          validFrom: grant.valid_from ?? now,
          validTo: grant.valid_to ?? 99_999_999_999_999
        },
        ctxWithConnection
      )
    ]);

    return grantorsTotalRate - grantorsSpentRate < grant.tdh_rate;
  }

  private async approveGrant(
    { grantId, validFrom }: { grantId: string; validFrom: number },
    ctx: RequestContext
  ) {
    await this.xTdhGrantsRepository.updateStatus(
      {
        grantId: grantId,
        status: XTdhGrantStatus.GRANTED,
        error: null,
        validFrom
      },
      ctx
    );
  }

  private async searchForMissingToken(
    grantCandidate: XTdhGrantEntity & { tokens: string[] },
    ctx: RequestContext
  ) {
    let missingToken: string | undefined = undefined;
    if (grantCandidate.tokens.length) {
      const actualTokens =
        await this.externalIndexingRepository.getAllTokenNumbersForCollection(
          { partition: grantCandidate.target_partition },
          ctx
        );
      missingToken = grantCandidate.tokens.find((it) => !actualTokens.has(it));
    }
    return missingToken;
  }

  private async updateWithStillPending(
    { grantId }: { grantId: string },
    ctx: RequestContext
  ) {
    await this.xTdhGrantsRepository.updateStatus(
      {
        grantId: grantId,
        status: XTdhGrantStatus.PENDING,
        error: null
      },
      ctx
    );
  }
}

export const reviewXTdhGrantUseCase = new ReviewXTdhGrantsInQueueUseCase(
  xTdhGrantsRepository,
  externalIndexingRepository,
  identitiesDb
);
