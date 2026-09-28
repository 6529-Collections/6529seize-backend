// Run against a bundled gif-preview module with matching native dependencies.
// Example: 6529 exec node scripts/benchmark-gif-preview.cjs ./preview.cjs ./input.gif 800
// Downloads and cloud mutations are deliberately outside this offline harness.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdtemp, copyFile, rm, stat, readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

async function main() {
  const [modulePath, sourcePath, heightText] = process.argv.slice(2);
  const height = Number(heightText);
  assert.ok(
    modulePath && sourcePath && Number.isSafeInteger(height) && height > 0,
    'Usage: benchmark-gif-preview.cjs <bundle> <source.gif> <height>'
  );
  const load = createRequire(resolve(modulePath));
  const sharp = load('sharp');
  const { prepareGifPreview } = load(resolve(modulePath));
  const directory = await mkdtemp(join(tmpdir(), 'gif-benchmark-'));
  try {
    const input = join(directory, 'source.gif');
    await copyFile(resolve(sourcePath), input);
    const original = await sharp(input).metadata();
    const sourceSha256 = createHash('sha256')
      .update(await readFile(input))
      .digest('hex');
    const started = performance.now();
    const output = await prepareGifPreview(input, {
      width: null,
      height,
      fit: 'cover'
    });
    const elapsedMs = Math.round(performance.now() - started);
    const result = await sharp(output, { animated: true }).metadata();
    assert.equal(result.pages, original.pages);
    assert.deepEqual(result.delay, original.delay);
    assert.equal(result.loop, original.loop);
    assert.ok(
      result.width * (result.pageHeight ?? result.height) * result.pages <=
        8 * 1024 * 1024
    );
    console.log(
      JSON.stringify({
        sourceSha256,
        requestedHeight: height,
        elapsedMs,
        maxRssKiB: process.resourceUsage().maxRSS,
        sourceBytes: (await stat(input)).size,
        outputBytes: (await stat(output)).size,
        width: result.width,
        height: result.pageHeight ?? result.height,
        frames: result.pages,
        timingAndLoopPreserved: true,
        node: process.version,
        versions: sharp.versions
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
