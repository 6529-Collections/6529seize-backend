import {
  ContextRecord,
  DocumentationProfile
} from '../artwork-documentation.types';
import { matchesSchema } from '../artwork-documentation.validation';

/** Cancelled/expired rows remain as receipts after their unreferenced bytes are released. */
export function publicationUpgradeRequiresAsset(asset: {
  state?: string;
  referenced?: boolean | number;
  reserved_bytes?: number;
}): boolean {
  const unreferenced = asset.referenced === false || asset.referenced === 0;
  return !(
    unreferenced &&
    asset.reserved_bytes === 0 &&
    (asset.state === 'cancelled' || asset.state === 'expired')
  );
}

export function museumUpgradePreview(
  context: ContextRecord,
  proposed: DocumentationProfile
) {
  const retained: string[] = [];
  const blockers: string[] = [];
  for (const [moduleId, answers] of Object.entries(context.modules)) {
    const definitions =
      proposed.modules.find((module) => module.id === moduleId)?.fields ?? [];
    for (const [field, answer] of Object.entries(answers)) {
      const path = `${moduleId}.${field}`;
      const definition = definitions.find((item) => item.id === field);
      if (
        !definition ||
        !definition.allowed_statuses.includes(answer.status) ||
        (proposed.intake_mode === 'publication_only' &&
          answer.intended_visibility !== 'public_record') ||
        (answer.status === 'provided' &&
          !matchesSchema(answer.value, definition.value_schema))
      )
        blockers.push(path);
      else retained.push(path);
    }
  }
  if (proposed.intake_mode === 'publication_only')
    for (const link of context.asset_links) {
      if (link.intended_visibility !== 'public_record')
        blockers.push(`asset:${link.asset_id}`);
    }
  return {
    retained_fields: retained,
    blocking_fields: Array.from(new Set(blockers)),
    notices:
      proposed.version === 3
        ? [
            'Existing answers and confirmed revisions are retained. The new draft uses the general museum record.',
            'Choose every media form that belongs to the work, then complete its relevant account.',
            'Earlier interview answers remain available; complete conversations can be added as sessions.',
            'Program terms come from the collection context. Earlier rights wording remains identified as historical writing.',
            'Confirmation applies to a specific version. An earlier confirmation does not confirm this upgraded draft.'
          ]
        : []
  };
}
