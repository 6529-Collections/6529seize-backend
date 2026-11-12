import { formatEther } from 'ethers';
import {
  LaunchAction,
  LaunchData,
  LaunchEvent
} from '@/drop-forge/drop-forge.types';

export function launchCardLink(chainId: number, claimId: number): string {
  const site = chainId === 1 ? 'https://6529.io' : 'https://staging.6529.io';
  return `[Claim #${claimId}](${site}/drop-forge/launch/${claimId})`;
}

function airdropGroup(data: LaunchData, action: LaunchAction): LaunchAction[] {
  return data.actions.filter(
    (it) =>
      it.kind === 'AIRDROP' &&
      it.phase === action.phase &&
      it.label === action.label
  );
}

function actionLabel(action: LaunchAction): string {
  return (action.label ?? 'Airdrops')
    .replace('Airdrop - Artist', 'Artist airdrops')
    .replace('Airdrop - Team', 'Team airdrops');
}

function operationName(data: LaunchData, action: LaunchAction): string {
  switch (action.kind) {
    case 'PAY_ARTIST':
      return 'artist payment';
    case 'INITIALIZE':
      return 'initialization';
    case 'METADATA':
      return 'metadata update';
    case 'UPDATE':
      return `${data.phases[action.phase].name} configuration`;
    default:
      return actionLabel(action);
  }
}

function confirmedWording(data: LaunchData, action: LaunchAction): string {
  switch (action.kind) {
    case 'PAY_ARTIST':
      return 'artist payment completed';
    case 'INITIALIZE':
      return 'initialized';
    case 'METADATA':
      return 'metadata updated';
    case 'UPDATE':
      return `${data.phases[action.phase].name} configured`;
    default: {
      const group = airdropGroup(data, action);
      const lastBatch =
        group.at(-1)?.id === action.id &&
        group.every((batch) => batch.state === 'CONFIRMED');
      return `${actionLabel(action)} ${lastBatch ? 'completed' : 'confirmed'}`;
    }
  }
}

function reportContent(
  data: LaunchData,
  event: LaunchEvent,
  action: LaunchAction,
  content: string
): string {
  const transaction = content.includes('[Transaction]')
    ? content.slice(content.indexOf('[Transaction]'))
    : '';
  if (event.content.startsWith('Confirmed '))
    return `Claim #${data.claim_id}: ${confirmedWording(data, action)}. ${transaction}`;
  if (event.content.startsWith('Signed '))
    return `Claim #${data.claim_id}: ${operationName(data, action)} signed; awaiting broadcast. ${transaction}`;
  if (event.content.startsWith('Reserved '))
    return `Claim #${data.claim_id}: Preparing ${operationName(data, action)}.`;
  return content;
}

function airdropCounts(wallets: number, tokens: number): string {
  return `${wallets} ${wallets === 1 ? 'wallet' : 'wallets'} · ${tokens} ${tokens === 1 ? 'token' : 'tokens'}`;
}

function actionDetails(data: LaunchData, action: LaunchAction): string {
  if (action.kind === 'PAY_ARTIST')
    return action.payment
      ? `Artist payment · ${formatEther(action.payment.amount_wei)} ETH`
      : 'Artist payment uses the recorded payee and final mint/subscription accounting.';
  if (action.kind === 'AIRDROP') {
    const recipients = action.remaining_recipients ?? action.recipients;
    const tokens = recipients.reduce((sum, row) => sum + row.amount, 0);
    const group = airdropGroup(data, action);
    const counts = airdropCounts(recipients.length, tokens);
    return group.length > 1
      ? `Batch ${group.indexOf(action) + 1} of ${group.length} · ${counts}`
      : counts;
  }
  const phase = data.phases[action.phase];
  return `Phase ${phase.name}: mint window ${new Date(phase.start * 1000).toISOString()} to ${new Date(phase.end * 1000).toISOString()}.`;
}

export function formatLaunchReport(
  data: LaunchData,
  event: LaunchEvent
): string {
  const card = launchCardLink(data.chain_id, data.claim_id);
  if (event.formatted) return `${event.content}\n\n${card}`;
  const explorer =
    data.chain_id === 1
      ? 'https://etherscan.io'
      : 'https://sepolia.etherscan.io';
  const content = event.content.replace(
    /\b0x[a-fA-F0-9]{64}\b/g,
    (hash) => `[Transaction](${explorer}/tx/${hash})`
  );
  const action = data.actions.find(
    (candidate) =>
      event.content.startsWith(`Confirmed ${candidate.id}:`) ||
      event.content.startsWith(`Signed ${candidate.id}:`) ||
      event.content.startsWith(`Reserved ${candidate.id}:`) ||
      event.content.includes(`(${candidate.id})`) ||
      event.content.includes(`for ${candidate.id}:`) ||
      event.content.includes(`for ${candidate.id};`) ||
      event.content.includes(`: ${candidate.id} confirmed after`)
  );
  const emoji = event.error ? '⚠️' : reportEmoji(event.content);
  const lines = [
    `${emoji} **${card}** · [Contract](${explorer}/address/${data.contract})`,
    action ? reportContent(data, event, action, content) : content
  ];
  const details = action ? [actionDetails(data, action)] : [];
  if (event.airdrop_counts) {
    const { wallets, tokens } = event.airdrop_counts;
    details.push(airdropCounts(wallets, tokens));
  }
  if (event.fee_wei !== undefined)
    details.push(`Gas ${formatEther(event.fee_wei)} ETH`);
  if (details.length) lines.push(details.join(' · '));
  return lines.join('\n');
}

function reportEmoji(content: string): string {
  if (content.startsWith('Confirmed ')) return '✅';
  if (content.startsWith('Signed ')) return '✍️';
  if (content.startsWith('Reserved ')) return '⏳';
  if (content.includes('Skipped') || content.includes('disabled')) return '⏭️';
  return 'ℹ️';
}

export function formatOperationsPost(message: string, error: boolean): string {
  if (
    ['⚠️', '🔔', '✅', '✍️', '⏳', '⏭️', 'ℹ️', '💰', '🧾'].some((emoji) =>
      message.startsWith(emoji + ' ')
    )
  )
    return message;
  if (error) return `⚠️ ${message}`;
  return `${message.toLowerCase().includes('fund') ? '💰' : '🧾'} ${message}`;
}
