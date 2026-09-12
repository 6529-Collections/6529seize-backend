import { ContextRecord } from '../artwork-documentation.types';

/** Lambda proxy bodies are JSON strings inside a JSON response; reserve capacity for the file list and response metadata. */
export function documentationContextBytes(context: ContextRecord): number {
  if (context.profile.version !== 3)
    return Buffer.byteLength(JSON.stringify(context.modules), 'utf8');
  return Buffer.byteLength(
    JSON.stringify(
      JSON.stringify({
        modules: context.modules,
        asset_links: context.asset_links,
        profile: context.profile
      })
    ),
    'utf8'
  );
}
