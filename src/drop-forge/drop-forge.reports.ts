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
  const lines = [
    `Drop Forge [creator contract](${explorer}/address/${data.contract}) / claim ${data.claim_id}`,
    action ? reportContent(data, event, action, content) : content
  ];
  if (action) lines.push(actionDetails(data, action));
  return lines.join('\n');
}
