import { formatEther } from 'ethers';
import {
  LaunchAction,
  LaunchData,
  LaunchEvent
} from '@/drop-forge/drop-forge.types';

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
      const group = data.actions.filter(
        (it) =>
          it.kind === 'AIRDROP' &&
          it.phase === action.phase &&
          it.label === action.label
      );
      const progress = group.every((it) => it.state === 'CONFIRMED')
        ? 'completed'
        : `batch ${group.indexOf(action) + 1}/${group.length} confirmed`;
      return `${actionLabel(action)} ${progress}`;
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

function actionDetails(data: LaunchData, action: LaunchAction): string {
  if (action.kind === 'PAY_ARTIST')
    return action.payment
      ? `Artist payment: ${formatEther(action.payment.amount_wei)} ETH to ${action.payment.recipient}.`
      : 'Artist payment uses the recorded payee and final mint/subscription accounting.';
  if (action.kind === 'AIRDROP') {
    const tokens = action.recipients.reduce(
      (sum, recipient) => sum + recipient.amount,
      0
    );
    return `Claim #${data.claim_id} — ${action.label ?? 'Subscription airdrops'}: recipient wallets: ${action.recipients.length}; tokens: ${tokens}.`;
  }
  const phase = data.phases[action.phase];
  return `Phase ${phase.name}: mint window ${new Date(phase.start * 1000).toISOString()} to ${new Date(phase.end * 1000).toISOString()}.`;
}

export function formatLaunchReport(
  data: LaunchData,
  event: LaunchEvent
): string {
  if (event.formatted) return event.content;
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
      event.content.includes(candidate.id + ':') ||
      event.content.endsWith('for ' + candidate.id)
  );
  const emoji = event.error ? '⚠️' : reportEmoji(event.content);
  const lines = [
    `${emoji} **Claim #${data.claim_id}** · [Contract](${explorer}/address/${data.contract})`,
    action ? reportContent(data, event, action, content) : content
  ];
  if (action) lines.push(actionDetails(data, action));
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
