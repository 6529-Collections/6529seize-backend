import * as path from 'node:path';

/** The sources a run can serve or reach: everything but `repo`. */
export type UrlSource = 'gateway' | 'relays' | 'ethereum' | 'files';

export const URL_SOURCES: readonly UrlSource[] = [
  'gateway',
  'relays',
  'ethereum',
  'files'
];

/** How the run gets one source. */
export type SourceSpec =
  /** A devnet endpoint someone else runs. */
  | { readonly kind: 'live'; readonly url: string }
  /** Answers from a recording directory; anything unrecorded fails. */
  | { readonly kind: 'replay'; readonly dir: string }
  /** A proxy to `upstream` that saves every answer into `dir`. */
  | { readonly kind: 'record'; readonly dir: string; readonly upstream: string }
  /** files: a directory of content-addressed files. */
  | { readonly kind: 'files'; readonly dir: string }
  /** ethereum: a local anvil, loaded from a state file when one is given. */
  | { readonly kind: 'anvil'; readonly state: string | null }
  /**
   * relays: the harness's relay. It starts from a copy of `dir` (recorded
   * events) or empty, and keeps what the run publishes.
   */
  | { readonly kind: 'relay'; readonly dir: string | null };

export type SourceSpecs = Partial<Record<UrlSource, SourceSpec>>;

const ALLOWED: Record<UrlSource, readonly SourceSpec['kind'][]> = {
  gateway: ['live', 'replay', 'record'],
  relays: ['live', 'relay'],
  ethereum: ['live', 'replay', 'record', 'anvil'],
  files: ['live', 'files']
};

/**
 * Parses `name=value`: a URL (`live`), `replay:<dir>`, `record:<dir>@<url>`,
 * `anvil` or `anvil:<state file>` for ethereum, `relay` or `relay:<dir>`
 * for relays,
 * or a directory for files.
 */
export function parseSourceArg(arg: string): [UrlSource, SourceSpec] {
  const equals = arg.indexOf('=');
  const name = arg.slice(0, equals) as UrlSource;
  if (equals < 1 || !URL_SOURCES.includes(name)) {
    throw new Error(
      `--source needs name=value with name one of ${URL_SOURCES.join(', ')}`
    );
  }
  const value = arg.slice(equals + 1);
  const spec = parseSpec(name, value);
  if (!ALLOWED[name].includes(spec.kind)) {
    throw new Error(`${name} can't be ${spec.kind}`);
  }
  return [name, spec];
}

function parseSpec(name: UrlSource, value: string): SourceSpec {
  if (/^(https?|wss?):\/\//.test(value)) return { kind: 'live', url: value };
  if (value.startsWith('replay:')) {
    return { kind: 'replay', dir: path.resolve(value.slice(7)) };
  }
  if (value.startsWith('record:')) {
    const rest = value.slice(7);
    const at = rest.lastIndexOf('@');
    if (at < 1) throw new Error('record needs record:<dir>@<upstream url>');
    return {
      kind: 'record',
      dir: path.resolve(rest.slice(0, at)),
      upstream: rest.slice(at + 1)
    };
  }
  if (value === 'anvil') return { kind: 'anvil', state: null };
  if (value.startsWith('anvil:')) {
    return { kind: 'anvil', state: path.resolve(value.slice(6)) };
  }
  if (value === 'relay') return { kind: 'relay', dir: null };
  if (value.startsWith('relay:')) {
    return { kind: 'relay', dir: path.resolve(value.slice(6)) };
  }
  if (name === 'files' && value)
    return { kind: 'files', dir: path.resolve(value) };
  throw new Error(`Can't read the ${name} source ${value}`);
}
