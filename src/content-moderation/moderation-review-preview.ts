import type { ModerationItem } from '@/content-moderation/moderation-review.types';

type PreviewItem = Pick<ModerationItem, 'evidence' | 'evidence_expires_at'>;

export function evidenceExpired(item: PreviewItem): boolean {
  return (
    !item.evidence ||
    item.evidence.evidence_expired === true ||
    (item.evidence_expires_at !== null &&
      item.evidence_expires_at <= Date.now())
  );
}

function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function partContent(part: unknown): unknown {
  return part && typeof part === 'object' && 'content' in part
    ? part.content
    : null;
}

export function checkPreview(item: PreviewItem): string | null {
  if (!item.evidence || evidenceExpired(item)) return null;
  const evidence = item.evidence;
  if (nonemptyText(evidence.text)) return evidence.text.slice(0, 160);
  const parts = Array.isArray(evidence.parts) ? evidence.parts : [];
  const content = [evidence.title, ...parts.map(partContent)]
    .filter(nonemptyText)
    .join('\n');
  return content ? content.slice(0, 160) : null;
}
