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
      `Batch ${action.id}: recipient wallets: ${action.recipients.length}; tokens: ${tokens}.`
    );
  } else if (action) {
    const phase = data.phases[action.phase];
    lines.push(
      `Phase ${phase.name}: mint window ${new Date(phase.start * 1000).toISOString()} to ${new Date(phase.end * 1000).toISOString()}.`
    );
  }
  return lines.join('\n');
}
