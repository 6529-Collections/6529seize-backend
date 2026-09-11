const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Resolve only from the supplied install/extracted ZIP, never the verifier's modules.
const root = path.resolve(process.argv[2] || '.');
const load = createRequire(path.join(root, 'index.js'));
assert.ok(
  load.resolve('sharp').startsWith(path.join(root, 'node_modules') + path.sep)
);
const sharp = load('sharp');
const fixtures = path.join(__dirname, 'media-fixtures');

async function verifyImages() {
  for (const format of ['jpeg', 'png', 'webp', 'tiff', 'avif', 'svg', 'gif']) {
    const input = fs.readFileSync(path.join(fixtures, format));
    const preview = await sharp(input, {
      pages: 1,
      limitInputPixels: 100000000
    })
      .timeout({ seconds: 25 })
      .rotate()
      .resize(16, 16, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const previewMeta = await sharp(preview).metadata();
    assert.equal(previewMeta.format, 'jpeg');
    assert.ok(previewMeta.width <= 16 && previewMeta.height <= 16);
    assert.equal(previewMeta.exif, undefined);
    const webp = await sharp(input).resize({ height: 6 }).webp().toBuffer();
    assert.equal((await sharp(webp).metadata()).height, 6);
    const chunks = [];
    await pipeline(
      Readable.from([input.subarray(0, 8), input.subarray(8)]),
      sharp({
        animated: format === 'gif',
        failOn: 'none',
        limitInputPixels: 1e9
      })
        .resize(6, null, { fit: 'inside', withoutEnlargement: true })
        .rotate(),
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        }
      })
    );
    const streamed = await sharp(Buffer.concat(chunks), {
      animated: true
    }).metadata();
    assert.equal(streamed.width, 6);
    if (format === 'gif') {
      assert.equal(streamed.pages, 2);
      assert.equal(streamed.pageHeight, 3);
      assert.deepEqual(streamed.delay, [80, 160]);
      assert.equal(streamed.loop, 2);
    }
  }
  const rotated = await sharp(fs.readFileSync(path.join(fixtures, 'jpeg')))
    .rotate()
    .jpeg()
    .toBuffer();
  const meta = await sharp(rotated).metadata();
  assert.equal(meta.width, 12);
  assert.equal(meta.height, 24);
  for (const field of ['exif', 'icc', 'xmp', 'orientation'])
    assert.equal(meta[field], undefined);
  await assert.rejects(sharp(Buffer.from('malformed-image')).metadata());
}

async function verifyImageScript() {
  const gif = await load('imagescript').GIF.decode(
    fs.readFileSync(path.join(fixtures, 'gif'))
  );
  gif.resize(12, 6);
  const meta = await sharp(await gif.encode(), { animated: true }).metadata();
  assert.equal(meta.pages, 2);
  assert.equal(meta.pageHeight, 6);
  assert.deepEqual(meta.delay, [80, 160]);
}

function verifyFfmpeg() {
  const ffmpeg = load('@ffmpeg-installer/ffmpeg');
  assert.ok(ffmpeg.path.startsWith(path.join(root, 'node_modules') + path.sep));
  assert.ok(fs.existsSync(ffmpeg.path));
  const output = execFileSync(ffmpeg.path, ['-version'], {
    encoding: 'utf8',
    timeout: 10000
  });
  assert.match(output, /ffmpeg version/);
  execFileSync(
    ffmpeg.path,
    ['-v', 'error', '-i', path.join(fixtures, 'png'), '-f', 'null', '-'],
    {
      timeout: 10000
    }
  );
  assert.equal(typeof load('fluent-ffmpeg'), 'function');
  console.log(
    JSON.stringify({
      ffmpeg: ffmpeg.version
    })
  );
}

async function main() {
  assert.equal(sharp.versions.sharp, '0.35.4');
  assert.equal(sharp.versions.vips, '8.18.6');
  assert.equal(sharp.versions.heif, '1.23.2');
  if (process.argv.includes('--lambda')) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.equal(process.versions.node.split('.')[0], '22');
    assert.ok(process.report.getReport().header.glibcVersionRuntime);
    assert.equal(
      load('@img/sharp-linux-x64/package').version,
      sharp.versions.sharp
    );
    const nativeRoot =
      path.join(root, 'node_modules/@img/sharp-linux-x64') + path.sep;
    assert.ok(
      Object.keys(require.cache).some(
        (file) => file.startsWith(nativeRoot) && file.endsWith('.node')
      )
    );
    if (fs.existsSync(path.join(root, 'node_modules/esbuild'))) {
      assert.match(
        load('esbuild').transformSync('const value = 1').code,
        /value/
      );
    }
  }
  await verifyImages();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  );
  if (manifest.dependencies?.imagescript) await verifyImageScript();
  if (manifest.dependencies?.['fluent-ffmpeg']) verifyFfmpeg();
  if (process.argv.includes('--lambda')) {
    const handler = load(path.join(root, 'index.js')).handler;
    assert.equal(typeof handler, 'function');
    const smoke = await handler(
      { operator_action: 'verify_media_dependencies_v1' },
      {},
      () => {}
    );
    assert.equal(smoke.status, 'ok');
    assert.equal(smoke.sharp, '0.35.4');
    const loadedNativeModules = Object.keys(require.cache).filter((file) =>
      file.endsWith('.node')
    );
    for (const file of loadedNativeModules) {
      const header = fs.readFileSync(file).subarray(0, 20);
      assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46');
      assert.equal(header.readUInt16LE(18), 62); // ELF machine: x86-64
    }
    console.log(
      JSON.stringify({
        nativeModules: loadedNativeModules.map((file) =>
          path.relative(root, file)
        )
      })
    );
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      versions: sharp.versions,
      result: 'passed'
    })
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
