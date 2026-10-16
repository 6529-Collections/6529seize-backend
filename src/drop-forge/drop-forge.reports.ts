import { LaunchData, LaunchEvent } from '@/drop-forge/drop-forge.types';

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
  const lines = [
    `Drop Forge [creator contract](${explorer}/address/${data.contract}) / claim ${data.claim_id}`,
    content
  ];
  const action = data.actions.find(
    (candidate) =>
      event.content.includes(candidate.id + ':') ||
      event.content.endsWith('for ' + candidate.id)
  );
  if (action?.kind === 'AIRDROP') {
    const tokens = action.recipients.reduce(
      (sum, recipient) => sum + recipient.amount,
      0
    );
    lines.push(
      `Claim #${data.claim_id} — ${action.label ?? 'Subscription airdrops'}: recipient wallets: ${action.recipients.length}; tokens: ${tokens}.`
    );
  } else if (action) {
    const phase = data.phases[action.phase];
    lines.push(
      `Phase ${phase.name}: mint window ${new Date(phase.start * 1000).toISOString()} to ${new Date(phase.end * 1000).toISOString()}.`
    );
  }
  if (action) {
    const label = (action.label ?? 'Airdrops')
      .replace('Airdrop - Artist', 'Artist airdrops')
      .replace('Airdrop - Team', 'Team airdrops');
    const group = data.actions.filter(
      (it) =>
        it.kind === 'AIRDROP' &&
        it.phase === action.phase &&
        it.label === action.label
    );
    const complete = group.every((it) => it.state === 'CONFIRMED');
    const operation =
      action.kind === 'INITIALIZE'
        ? 'initialization'
        : action.kind === 'METADATA'
          ? 'metadata update'
          : action.kind === 'UPDATE'
            ? `${data.phases[action.phase].name} configuration`
            : label;
    const transaction = content.includes('[Transaction]')
      ? content.slice(content.indexOf('[Transaction]'))
      : '';
    if (event.content.startsWith('Confirmed ')) {
      const wording =
        action.kind === 'INITIALIZE'
          ? 'initialized'
          : action.kind === 'METADATA'
            ? 'metadata updated'
            : action.kind === 'UPDATE'
              ? `${data.phases[action.phase].name} configured`
              : `${label} ${complete ? 'completed' : `batch ${group.indexOf(action) + 1}/${group.length} confirmed`}`;
      lines[1] = `Claim #${data.claim_id}: ${wording}. ${transaction}`;
    } else if (event.content.startsWith('Signed '))
      lines[1] = `Claim #${data.claim_id}: ${operation} signed; awaiting broadcast. ${transaction}`;
    else if (event.content.startsWith('Reserved '))
      lines[1] = `Claim #${data.claim_id}: Preparing ${operation}.`;
  }
  return lines.join('\n');
}
