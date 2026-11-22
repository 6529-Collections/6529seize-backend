import * as fs from 'node:fs';
import { once } from 'node:events';

type Write = (chunk: string) => Promise<void>;

async function writeArray(write: Write, values: unknown[]): Promise<void> {
  if (!values.length) {
    await write('[]');
    return;
  }
  await write('[\n');
  for (let i = 0; i < values.length; i++) {
    const comma = i < values.length - 1 ? ',' : '';
    await write(`    ${JSON.stringify(values[i])}${comma}\n`);
  }
  await write('  ]');
}

/**
 * Writes the export document as one JSON object, one array element at a time,
 * so a large export never becomes a single string in memory. The output
 * parses to the same value as JSON.stringify(document).
 */
export async function writeJsonDocument(
  path: string,
  document: Record<string, unknown>
): Promise<void> {
  const out = fs.createWriteStream(path, { encoding: 'utf8' });
  const write: Write = async (chunk) => {
    if (!out.write(chunk)) {
      await once(out, 'drain');
    }
  };
  try {
    await write('{\n');
    const entries = Object.entries(document).filter(
      ([, value]) => value !== undefined
    );
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      await write(`  ${JSON.stringify(key)}: `);
      if (Array.isArray(value)) {
        await writeArray(write, value);
      } else {
        await write(JSON.stringify(value));
      }
      await write(i < entries.length - 1 ? ',\n' : '\n');
    }
    await write('}\n');
  } finally {
    out.end();
    await once(out, 'close');
  }
}
