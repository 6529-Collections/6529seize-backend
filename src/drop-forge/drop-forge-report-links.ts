import { MINTING_CLAIMS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { hasPublishedMemePage } from '@/drop-forge/drop-forge.readiness.repository';
import { launchCardLink, memePageLink } from '@/drop-forge/drop-forge.reports';
import { lookupPrimaryEnsName } from '@/ens-lookup';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { getCanonicalNextMintNumber } from '@/memes-calendar';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';

export async function claimReportLinks(
  chainId: number,
  contract: string,
  claimId: number,
  ctx: RequestContext,
  hasCard?: boolean
): Promise<string> {
  const hasClaim =
    hasCard ??
    (await sqlExecutor
      .oneOrNull<{
        claim_id: number;
      }>(
        `SELECT claim_id FROM ${MINTING_CLAIMS_TABLE} WHERE contract = :contract AND claim_id = :claimId LIMIT 1`,
        { contract: contract.toLowerCase(), claimId },
        ctx.connection
          ? { wrappedConnection: ctx.connection }
          : { forcePool: DbPoolName.WRITE }
      )
      .then(Boolean, () => false));
  const hasMeme =
    claimId === getCanonicalNextMintNumber(new Date(Date.now())) ||
    (await hasPublishedMemePage(claimId, ctx).catch(() => false));
  const claim = hasClaim
    ? launchCardLink(chainId, claimId)
    : `Claim #${claimId}`;
  const meme = hasMeme ? memePageLink(chainId, claimId) : `Meme #${claimId}`;
  return `**${claim}** · **${meme}**`;
}

export async function reportRecipientEns(
  address: string
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const name = await lookupPrimaryEnsName(address);
        const resolved =
          name && (await getEthereumRpcProvider(1).resolveName(name));
        return resolved && resolved.toLowerCase() === address.toLowerCase()
          ? name
          : null;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1200);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
