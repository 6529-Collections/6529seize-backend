/**
 * The few settings of a validator's TOML configuration the harness checks
 * or sets before it serves a frozen copy: the chain API's listen address
 * and the peer settings. A line-based reader: sections, and `key = value`
 * lines with a string, a boolean or a one-line array.
 */

interface Setting {
  readonly section: string;
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

function settings(text: string): Setting[] {
  const result: Setting[] = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, line) => {
    const content = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(content);
    if (header) {
      section = header[1].trim();
      return;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(content);
    if (pair) {
      result.push({ section, key: pair[1], value: pair[2].trim(), line });
    }
  });
  return result;
}

const LOOPBACK = /^"127\.0\.0\.1:(\d{1,5})"$/;

/**
 * The text with `[chain.api] listen` set to 127.0.0.1 on `port`, the
 * section added when the file has none.
 */
export function withLoopbackListen(text: string, port: number): string {
  const lines = text.split(/\r?\n/);
  const value = `listen = "127.0.0.1:${port}"`;
  const found = settings(text).find(
    (s) => s.section === 'chain.api' && s.key === 'listen'
  );
  if (found) {
    lines[found.line] = value;
    return lines.join('\n');
  }
  const header = lines.findIndex((l) => l.trim() === '[chain.api]');
  if (header !== -1) {
    lines.splice(header + 1, 0, value);
    return lines.join('\n');
  }
  return `${text.replace(/\s*$/, '')}\n\n[chain.api]\n${value}\n`;
}

/** The chain API's port when it listens on 127.0.0.1, else null. */
export function loopbackPort(text: string): number | null {
  const found = settings(text).find(
    (s) => s.section === 'chain.api' && s.key === 'listen'
  );
  const match = found ? LOOPBACK.exec(found.value) : null;
  return match ? Number(match[1]) : null;
}

const PEER_LISTS = [
  'bootstrap',
  'listen',
  'external',
  'relays',
  'sentries',
  'direct_peers'
];
const PEER_SWITCHES = ['onion', 'bootstrap_service', 'relay_service'];

/** Each `[p2p]` setting that would have the node reach or take a peer. */
export function peerSettings(text: string): string[] {
  const problems: string[] = [];
  for (const s of settings(text).filter((s) => s.section === 'p2p')) {
    if (PEER_LISTS.includes(s.key) && !/^\[\s*\]$/.test(s.value)) {
      problems.push(`p2p.${s.key} = ${s.value}`);
    }
    if (PEER_SWITCHES.includes(s.key) && s.value === 'true') {
      problems.push(`p2p.${s.key} = true`);
    }
  }
  return problems;
}
