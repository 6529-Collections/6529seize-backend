import { formatEther } from 'ethers';
import { DropForgeConfig } from './drop-forge.config';
import { EthereumLaunchChain } from './drop-forge.chain';
import { addLaunchEvent, DropForgeRepository } from './drop-forge.repository';
import { readForgeSettings } from './drop-forge.settings';
import { LaunchSafetyError, SupplyEvidenceError } from './drop-forge.types';
import { RESEARCH_DELAY_SECONDS } from './drop-forge.research';

export const POST_MINT_PREVIEW_DELAY = 15 * 60;

export async function recordPostMintPreview(
  id: string,
  config: DropForgeConfig,
  repository: DropForgeRepository,
  chain: Pick<EthereumLaunchChain, 'previewPostMint'>,
  now: number
): Promise<void> {
  await repository.change(
    id,
    async (record, ctx) => {
      const closes = record.data.phases.at(-1)!.end;
      if (
        record.data.post_mint_preview ||
        now < closes + POST_MINT_PREVIEW_DELAY ||
        record.state === 'DRAFT' ||
        record.state === 'CANCELLED'
      )
        return;
      if (now >= closes + RESEARCH_DELAY_SECONDS) {
        record.data.post_mint_preview = { checked_at: Date.now() };
        addLaunchEvent(
          record,
          `ℹ️ **Claim #${record.data.claim_id} · Post-mint preview**\n\nThe preview window passed. The 18:00 execution performs fresh checks. No preview calculations were used.`
        );
        record.data.events.at(-1)!.formatted = true;
        return;
      }
      try {
        const settings = await readForgeSettings(config, ctx);
        const alreadyPaid = record.data.actions.some(
          (action) =>
            action.kind === 'PAY_ARTIST' && action.state === 'CONFIRMED'
        );
        const preview = await chain.previewPostMint(
          record.data,
          settings.pay_artist_enabled && !alreadyPaid
        );
        record.data.post_mint_preview = {
          checked_at: Date.now(),
          evidence: preview.evidence
        };
        const payment = artistPreviewLabel(
          preview.payment,
          alreadyPaid,
          config
        );
        const status = settings.automation_enabled
          ? 'Scheduled for **18:00 Europe/Athens**, subject to fresh checks.'
          : '**Automatic launch is Off.** No automatic transfer will run until enabled.';
        const explorer =
          record.data.chain_id === 1
            ? 'https://etherscan.io'
            : 'https://sepolia.etherscan.io';
        addLaunchEvent(
          record,
          `🔔 **Claim #${record.data.claim_id} · Public mint closed**\n\nRPC and database agree: **${preview.evidence.rpc_total} minted**.\n\n- 🎁 Research top-up: **${preview.research} editions**\n- 🎨 Artist payment: **${payment}**\n\n${status}\n\nCompared at [finalized block ${preview.evidence.block_number}](${explorer}/block/${preview.evidence.block_number}). This is a preview, not confirmation of delivery.`
        );
      } catch (error) {
        const reason =
          error instanceof LaunchSafetyError
            ? error.message
            : 'Post-mint verification unavailable';
        const evidence =
          error instanceof SupplyEvidenceError ? error.evidence : undefined;
        record.data.post_mint_preview = {
          checked_at: Date.now(),
          error: reason,
          evidence
        };
        addLaunchEvent(
          record,
          `⚠️ **Claim #${record.data.claim_id} · Post-mint preview needs attention**\n\n${reason}\n\nRPC: **${evidence?.rpc_total ?? 'unavailable'}** · Database: **${evidence?.db_total ?? 'unavailable'}**\n\nNo preview amount is approved. This preview will not retry; the 18:00 execution performs fresh checks.`,
          true
        );
      }
      record.data.events.at(-1)!.formatted = true;
    },
    {}
  );
}

function artistPreviewLabel(
  payment: Awaited<
    ReturnType<EthereumLaunchChain['previewPostMint']>
  >['payment'],
  alreadyPaid: boolean,
  config: DropForgeConfig
): string {
  if (alreadyPaid) return 'Already completed';
  if (!payment) return 'Off';
  const amount = `${formatEther(payment.amount_wei)} ETH`;
  if (
    !config.maxArtistPayment ||
    BigInt(payment.amount_wei) > config.maxArtistPayment
  )
    return `${amount} · blocked by the configured payment limit`;
  return amount;
}
