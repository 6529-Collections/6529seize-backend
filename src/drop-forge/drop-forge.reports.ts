import { formatEther } from 'ethers';
import {
  LaunchAction,
  LaunchData,
  LaunchEvent,
  transactionAirdropRecipients
} from '@/drop-forge/drop-forge.types';

const siteForChain = (chainId: number) =>
  chainId === 1 ? 'https://6529.io' : 'https://staging.6529.io';
const MINT_WATCH_PREFIX = '[👀 MINT WATCH]';
const mintWatchEndings = {
  ready: 'is Ready ✅',
  soldOut: 'skipped (sold out) ✅',
  warning: 'needs attention ⚠️',
  urgent: 'needs attention 🚨'
};

export type MintWatchOutcome = keyof typeof mintWatchEndings;

export function launchCardLink(chainId: number, claimId: number): string {
  return `[Claim #${claimId}](${siteForChain(chainId)}/drop-forge/launch/${claimId})`;
}

export function memePageLink(chainId: number, claimId: number): string {
  return `[Meme #${claimId}](${siteForChain(chainId)}/the-memes/${claimId})`;
}

export function formatMintWatchReport(
  claimLabels: string,
  phase: string,
  outcome: MintWatchOutcome,
  issues: string[]
): string {
  const headline = `${MINT_WATCH_PREFIX} ${claimLabels} · ${phase} ${mintWatchEndings[outcome]}`;
  if (!issues.length) return headline;
  return `${headline}\n\n${issues.map((issue) => '- ' + issue).join('\n')}`;
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
      const status =
        lastBatch && group.every((batch) => !batch.unfilled_tokens)
          ? 'completed'
          : 'confirmed';
      return `${actionLabel(action)} ${status}`;
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
  const failureMarker = ` failed (${action.id}): `;
  const failureStart = content.indexOf(failureMarker);
  if (event.error && failureStart !== -1) {
    const operation = operationName(data, action);
    const label = operation.charAt(0).toUpperCase() + operation.slice(1);
    return `${label} failed. ${content.slice(failureStart + failureMarker.length)}`;
  }
  return content;
}

function airdropCounts(wallets: number, tokens: number): string {
  return `${wallets} ${wallets === 1 ? 'wallet' : 'wallets'} · ${tokens} ${tokens === 1 ? 'token' : 'tokens'}`;
}

const utcDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC'
});
const utcTime = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC'
});

function utcTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${utcDate.format(date)}, ${utcTime.format(date)} UTC`;
}

function mintWindow(phase: LaunchData['phases'][number]): string {
  const start = new Date(phase.start * 1000);
  const end = new Date(phase.end * 1000);
  const day = utcDate.format(start);
  const endDay = utcDate.format(end);
  const endLabel =
    day === endDay ? utcTime.format(end) : `${endDay}, ${utcTime.format(end)}`;
  return `${phase.name} mint window · ${day}, ${utcTime.format(start)}–${endLabel} UTC`;
}

function actionDetails(data: LaunchData, action: LaunchAction): string {
  if (action.kind === 'PAY_ARTIST')
    return action.payment
      ? `Artist payment · ${formatEther(action.payment.amount_wei)} ETH`
      : 'Artist payment uses the recorded payee and final mint/subscription accounting.';
  if (action.kind === 'AIRDROP') {
    const recipients = transactionAirdropRecipients(action);
    const tokens = recipients.reduce((sum, row) => sum + row.amount, 0);
    const group = airdropGroup(data, action);
    const counts = airdropCounts(recipients.length, tokens);
    return group.length > 1
      ? `Batch ${group.indexOf(action) + 1} of ${group.length} · ${counts}`
      : counts;
  }
  const phase = data.phases[action.phase];
  return mintWindow(phase);
}

export function formatLaunchReport(
  data: LaunchData,
  event: LaunchEvent,
  options?: { claimLabels: string; recipientEns?: string | null }
): string {
  const claimLabels =
    options?.claimLabels ??
    `**${launchCardLink(data.chain_id, data.claim_id)}** · **${memePageLink(data.chain_id, data.claim_id)}**`;
  if (event.formatted) {
    const leading = /^(🔔|⚠️|✅) /.exec(event.content);
    return `${leading?.[0] ?? ''}${claimLabels}\n\n${event.content.slice(leading?.[0].length ?? 0)}`;
  }
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
  const message = action
    ? reportContent(data, event, action, content)
    : content;
  const prefix = `Claim #${data.claim_id}: `;
  const body = message.startsWith(prefix)
    ? message.slice(prefix.length)
    : message;
  const lines = [
    `${emoji} ${claimLabels} · [Contract](${explorer}/address/${data.contract})`
  ];
  if (action && event.next_wallet_retry !== undefined) {
    const reason = body.endsWith('insufficient gas funds')
      ? 'The operational wallet has insufficient ETH.'
      : 'The operational wallet needs contract admin permission.';
    lines.push(
      `${action.kind === 'INITIALIZE' ? 'Initialization' : operationName(data, action)} blocked. ${reason}`
    );
  } else {
    lines.push(body);
  }
  const details =
    action && !event.planned_airdrop && !event.content.includes(': Sold out.')
      ? [actionDetails(data, action)]
      : [];
  if (event.planned_airdrop && action) {
    const { tokens, wallets, recipient } = event.planned_airdrop;
    const cards = `${tokens} ${tokens === 1 ? 'card' : 'cards'}`;
    let destination = `across ${wallets} ${wallets === 1 ? 'wallet' : 'wallets'}`;
    if (recipient) {
      const address = `[${recipient.slice(0, 6)}…${recipient.slice(-4)}](${explorer}/address/${recipient})`;
      destination = options?.recipientEns
        ? `to ${options.recipientEns} (${address})`
        : `to ${address}`;
    }
    const name = actionLabel(action)
      .replace(/^Artist airdrops$/, 'artist airdrop')
      .replace(/^Team airdrops$/, 'team airdrop')
      .replace(' Subscription Airdrops', ' subscriber airdrop');
    details.push(`Planned ${name} · ${cards} ${destination}`);
  }
  if (
    event.error &&
    action &&
    ['INITIALIZE', 'UPDATE'].includes(action.kind) &&
    data.actions.some(
      (candidate) =>
        candidate.kind === 'AIRDROP' &&
        candidate.phase === action.phase &&
        candidate.state !== 'CONFIRMED' &&
        candidate.state !== 'SKIPPED' &&
        candidate.id !== 'research-airdrop'
    )
  )
    details.push(
      `${data.phases[action.phase].name} airdrops are waiting for ${action.kind === 'INITIALIZE' ? 'initialization' : 'the phase update'}.`
    );
  if (
    action?.unfilled_tokens &&
    (event.content.startsWith('Confirmed ') ||
      event.content.includes('Recovery EXECUTED for '))
  ) {
    const requested = action.recipients.reduce(
      (total, row) => total + row.amount,
      0
    );
    details.push(
      `${requested - action.unfilled_tokens} of ${requested} requested cards delivered`
    );
  }
  if (event.airdrop_counts) {
    const { wallets, tokens } = event.airdrop_counts;
    details.push(airdropCounts(wallets, tokens));
  }
  if (event.fee_wei !== undefined)
    details.push(`Gas ${formatEther(event.fee_wei)} ETH`);
  if (details.length) lines.push(details.join(' · '));
  if (typeof event.next_wallet_retry === 'number')
    lines.push(`Next attempt · ${utcTimestamp(event.next_wallet_retry)}`);
  else if (event.next_wallet_retry === null)
    lines.push(
      action?.state === 'SIGNED' && action.broadcast_possible !== false
        ? 'Reconcile the signed transaction in Drop Forge Launch before continuing manually.'
        : 'Complete the remaining work manually in Drop Forge Launch.'
    );
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
  if (message.startsWith(MINT_WATCH_PREFIX + ' ')) return message;
  if (
    ['⚠️', '🔔', '✅', '✍️', '⏳', '⏭️', 'ℹ️', '💰', '🧾'].some((emoji) =>
      message.startsWith(emoji + ' ')
    )
  )
    return message;
  if (error) return `⚠️ ${message}`;
  return `${message.toLowerCase().includes('fund') ? '💰' : '🧾'} ${message}`;
}
