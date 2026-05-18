const MAX_DROP_LABEL_LENGTH = 80;

export function getRatingChangeEmoji(value: number): string {
  if (value > 0) {
    return '🚀 ';
  }
  if (value < 0) {
    return '💔 ';
  }
  return '';
}

export function formatSignedLocaleNumber(value: number): string {
  if (value === 0) {
    return '0';
  }
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${Math.abs(value).toLocaleString('en-US')}`;
}

export function buildDropVotePushTitle({
  voterHandle,
  vote,
  voteChange
}: {
  voterHandle: string;
  vote: number;
  voteChange: number | null;
}): string {
  const emoji = getRatingChangeEmoji(voteChange ?? vote);
  if (voteChange !== null && voteChange !== vote) {
    return `${emoji}${voterHandle} updated their rating on your drop`;
  }
  return `${emoji}${voterHandle} rated your drop`;
}

export function buildDropVotePushBody({
  dropBody,
  vote,
  voteChange,
  totalVote
}: {
  dropBody: string | null;
  vote: number;
  voteChange: number | null;
  totalVote: number | null;
}): string {
  const dropLabel = dropBody === null ? '' : truncateDropLabel(dropBody);
  const lines = dropLabel ? [`Drop: ${dropLabel}`] : [];
  if (voteChange !== null && voteChange !== vote) {
    lines.push(`Change: ${formatSignedLocaleNumber(voteChange)}`);
  }
  lines.push(`New rating: ${formatSignedLocaleNumber(vote)}`);
  if (totalVote !== null) {
    lines.push(`Total Drop Rating: ${formatSignedLocaleNumber(totalVote)}`);
  }
  return lines.join('\n');
}

export function truncateDropLabel(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= MAX_DROP_LABEL_LENGTH) {
    return normalized;
  }
  return `${characters.slice(0, MAX_DROP_LABEL_LENGTH - 3).join('')}...`;
}
