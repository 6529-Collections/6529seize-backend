import { RecordRegistry } from '@/signed-records/record-index';
import {
  PersonalHandlerDeps,
  registerPersonalRecordTypes
} from './personal-record-types';

// Bodies are checked without the tables: these deps are never called.
const unused = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('Only the body checks run here');
    }
  }
) as never;

const registry = registerPersonalRecordTypes(new RecordRegistry(), {
  owners: unused,
  tables: unused,
  live: unused
} as PersonalHandlerDeps);

/**
 * The type's own body check, as the indexer runs it: a reason, or null.
 * The import checks every item with it, so one bad row never drops an
 * owner's whole entry in a rebuild.
 */
export function checkPersonalItem(
  family: 'ps' | 'pv',
  item: {
    readonly t: string;
    readonly k: string;
    readonly b: Record<string, unknown> | null;
  }
): string | null {
  const handler = registry.find(family, item.t, family === 'pv');
  if (!handler) return 'unknown type';
  try {
    handler.validate({
      owner: '',
      family,
      type: item.t,
      key: item.k,
      body: item.b,
      order: { anchor: 0, claimedTime: 0, eventId: '0x' },
      eventId: null,
      sealedClass: family === 'pv' ? 1 : null,
      writer: 'author'
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
