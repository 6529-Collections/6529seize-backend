import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  boundPngPreview,
  pngInputFailure,
  PNG_PREVIEW_LIMITS,
  PreviewTarget
} from '@/media/png-preview-policy';
import { UnprocessableResizeInput } from '@/media/resize-input';

const DEADLINE_MS = 30_000;
const UPLOAD_RESERVE_MS = 2000;
const MAX_TREE_RSS_BYTES = 1024 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 4096;

// Paths/options are argv, never executable input. The same pure policy functions
// run in both processes. Sharp/native allocations are reclaimed on child exit.
export const PNG_PREVIEW_SCRIPT = String.raw`
const fs = require('node:fs');
const heartbeat = () => fs.writeSync(3, String(process.memoryUsage().rss) + '\n');
heartbeat();
const timer = setInterval(heartbeat, 10);
timer.unref();
const inspect = ${pngInputFailure.toString()};
const bound = ${boundPngPreview.toString()};
const reject = code => { throw Object.assign(new Error(code), { inputCode: code }); };
(async () => {
  const sharp = require(process.argv[1]);
  sharp.cache(false);
  sharp.concurrency(1);
  const input = process.argv[2], output = process.argv[3];
  const target = JSON.parse(process.argv[4]);
  const limits = JSON.parse(process.argv[5]);
  if (fs.statSync(input).size > limits.sourceBytes) reject('SOURCE_TOO_LARGE');
  const metadata = await sharp(input, { failOn: 'error', limitInputPixels: limits.pixels8, pages: 1 }).metadata();
  const failure = inspect(metadata, limits);
  if (failure) reject(failure);
  let image = sharp(input, { failOn: 'error', limitInputPixels: limits.pixels8, pages: 1 }).rotate();
  if (target) {
    const planned = bound(metadata, target, limits);
    image = image.resize(planned.width, planned.height, {
      fit: planned.fit, withoutEnlargement: true, fastShrinkOnLoad: true
    });
  }
  await image.png().toFile(output);
  const bytes = fs.statSync(output).size;
  if (bytes > (target ? limits.outputBytes : limits.sourceBytes)) reject('OUTPUT_TOO_LARGE');
  if (target) {
    const preview = sharp(output, { failOn: 'error', limitInputPixels: limits.outputPixels });
    const info = await preview.metadata();
    if (info.width > limits.outputSide || info.height > limits.outputSide ||
        info.width * info.height > limits.outputPixels) reject('OUTPUT_TOO_LARGE');
    await preview.raw().toBuffer();
  }
  process.stdout.write(JSON.stringify({ ok: true }));
})().catch(error => {
  // Keep this narrow, version-specific whitelist covered by corrupt-file tests.
  const code = error.inputCode || (/Input (?:file contains unsupported image format|file has corrupt header|image exceeds pixel limit)|vipspng: libpng read error/i.test(error.message) ? 'INVALID_IMAGE' : null);
  if (code) process.stdout.write(JSON.stringify({ code }));
  else { process.stderr.write('PNG_PREVIEW_WORKER_FAILED'); process.exitCode = 1; }
}).finally(() => clearInterval(timer));
`;

/** Only the bounded worker protocol can classify an input as permanently invalid. */
export function parsePngWorkerResult(stdout: string): void {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('PNG_PREVIEW_INVALID_RESPONSE');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result))
    throw new Error('PNG_PREVIEW_INVALID_RESPONSE');
  const fields = Object.keys(result);
  if (fields.length !== 1) throw new Error('PNG_PREVIEW_INVALID_RESPONSE');
  if ('ok' in result && result.ok === true) return;
  if ('code' in result) {
    switch (result.code) {
      case 'INVALID_IMAGE':
      case 'DECODED_IMAGE_TOO_LARGE':
      case 'SOURCE_TOO_LARGE':
      case 'OUTPUT_TOO_LARGE':
        throw new UnprocessableResizeInput(result.code);
    }
  }
  throw new Error('PNG_PREVIEW_INVALID_RESPONSE');
}

/** The RSS watchdog is a sampled guard, not a hard native allocation limit. */
async function runPngWorker(
  input: string,
  output: string,
  target: PreviewTarget | null,
  timeout: number
): Promise<void> {
  const directory = dirname(input);
  const child = spawn(
    process.execPath,
    [
      '--max-old-space-size=256',
      '-e',
      PNG_PREVIEW_SCRIPT,
      require.resolve('sharp'),
      input,
      output,
      JSON.stringify(target),
      JSON.stringify(PNG_PREVIEW_LIMITS)
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        // Keep native loader paths while withholding credentials and Node hooks.
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH,
        DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory
      }
    }
  );
  let failure: Error | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('PNG_PREVIEW_WORKER_FAILED'));
      else resolve();
    });
  });
  const terminate = (error: Error) => {
    failure ??= error;
    child.kill('SIGKILL');
  };
  let stdout = '';
  let diagnostics = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_PROTOCOL_BYTES)
      terminate(new Error('PNG_PREVIEW_INVALID_RESPONSE'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.length;
    if (diagnostics > MAX_PROTOCOL_BYTES)
      terminate(new Error('PNG_PREVIEW_WORKER_FAILED'));
  });
  let heartbeat = '';
  let lastReport = Date.now();
  child.stdio[3]?.on('data', (chunk: Buffer) => {
    heartbeat += chunk.toString();
    const lines = heartbeat.split('\n');
    heartbeat = lines.pop()!;
    if (heartbeat.length > 64)
      terminate(new Error('PNG_PREVIEW_INVALID_MEMORY_REPORT'));
    for (const line of lines) {
      const rss = Number(line);
      if (!Number.isSafeInteger(rss) || rss < 1)
        terminate(new Error('PNG_PREVIEW_INVALID_MEMORY_REPORT'));
      else if (rss + process.memoryUsage().rss > MAX_TREE_RSS_BYTES)
        terminate(new Error('PNG_PREVIEW_MEMORY_BUDGET_EXCEEDED'));
      lastReport = Date.now();
    }
  });
  const deadline = setTimeout(
    () => terminate(new Error('PNG_PREVIEW_DEADLINE_EXCEEDED')),
    timeout
  );
  const monitor = setInterval(() => {
    if (Date.now() - lastReport > 5000)
      terminate(new Error('PNG_PREVIEW_MEMORY_MONITOR_UNAVAILABLE'));
  }, 1000);
  try {
    await completion;
    parsePngWorkerResult(stdout);
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
  }
}

async function preparePngFile(
  input: string,
  target: PreviewTarget | null,
  remainingTimeMs: number
): Promise<string> {
  const timeout = Math.min(DEADLINE_MS, remainingTimeMs - UPLOAD_RESERVE_MS);
  if (timeout < 1000) throw new Error('PNG_PREVIEW_DEADLINE_EXCEEDED');
  const output = join(dirname(input), `png-${randomUUID()}.png`);
  try {
    await runPngWorker(input, output, target, timeout);
    const file = await stat(output);
    if (!file.isFile() || !file.size)
      throw new Error('PNG_PREVIEW_MISSING_OUTPUT');
    return output;
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function preparePngPreview(
  input: string,
  target: PreviewTarget,
  remainingTimeMs = DEADLINE_MS + UPLOAD_RESERVE_MS
): Promise<string> {
  if (
    [target.width, target.height].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 1)
    ) ||
    (target.width === null && target.height === null) ||
    !['cover', 'inside', 'outside'].includes(target.fit)
  )
    throw new UnprocessableResizeInput('INVALID_IMAGE');
  return preparePngFile(input, target, remainingTimeMs);
}

/** Privacy stripping keeps original dimensions; it is independently bounded. */
export function sanitizePngFile(input: string): Promise<string> {
  return preparePngFile(input, null, DEADLINE_MS + UPLOAD_RESERVE_MS);
}
