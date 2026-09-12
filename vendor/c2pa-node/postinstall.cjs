/**
 * Copyright 2023 Adobe. All Rights Reserved.
 * Modified by 6529 in 2026: pinned, bounded native-binary installation.
 * Adobe permits use, modification, and distribution under the accompanying
 * upstream license. The upstream SDK and native binaries are unchanged.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const MAX_ARCHIVE_SIZE = 64 * 1024 * 1024;
const MAX_NATIVE_SIZE = 256 * 1024 * 1024;
const DOWNLOAD_PREFIX =
  'https://github.com/contentauth/c2pa-js/releases/download/%40contentauth/c2pa-node%400.9.5/';
const SUPPORTED = new Set([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64'
]);

function selectAsset(manifest, platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) throw new Error(`Unsupported C2PA platform: ${key}`);
  const asset = manifest?.assets?.[key];
  if (manifest?.schema_version !== 1 || !asset) {
    throw new Error(`Missing pinned C2PA asset: ${key}`);
  }
  for (const [field, maximum] of [
    ['archive_size', MAX_ARCHIVE_SIZE],
    ['native_size', MAX_NATIVE_SIZE]
  ]) {
    if (
      !Number.isSafeInteger(asset[field]) ||
      asset[field] <= 0 ||
      asset[field] > maximum
    ) {
      throw new Error(`Invalid C2PA ${field}`);
    }
  }
  for (const field of ['archive_sha256', 'native_sha256']) {
    if (
      typeof asset[field] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset[field])
    ) {
      throw new Error(`Invalid C2PA ${field}`);
    }
  }
  if (
    typeof asset.entry_name !== 'string' ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(asset.entry_name)
  ) {
    throw new Error('Invalid C2PA native entry name');
  }
  if (
    typeof asset.url !== 'string' ||
    !asset.url.startsWith(DOWNLOAD_PREFIX) ||
    !/^[a-zA-Z0-9._-]+\.zip$/.test(asset.url.slice(DOWNLOAD_PREFIX.length))
  ) {
    throw new Error('Invalid official C2PA asset URL');
  }
  return asset;
}

function integrityStream(size, digest) {
  let received = 0;
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > size) return done(new Error('C2PA size limit exceeded'));
      hash.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      if (received !== size || hash.digest('hex') !== digest) {
        return done(new Error('C2PA size or SHA256 mismatch'));
      }
      done();
    }
  });
}

async function matchesNative(file, asset, signal) {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.size !== asset.native_size) return false;
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { signal })) {
    size += chunk.length;
    if (size > asset.native_size) return false;
    hash.update(chunk);
  }
  return (
    size === asset.native_size && hash.digest('hex') === asset.native_sha256
  );
}

function allowedRedirect(url) {
  const parsed = new URL(url);
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'release-assets.githubusercontent.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''
  );
}

async function downloadArchive(asset, file, fetchImpl, signal) {
  let url = asset.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { 'Accept-Encoding': 'identity' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3)
        throw new Error('Invalid C2PA asset redirect');
      url = new URL(location, url).href;
      if (!allowedRedirect(url))
        throw new Error('Untrusted C2PA asset redirect');
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`C2PA asset download failed: HTTP ${response.status}`);
    }
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (
      (length !== null && length !== String(asset.archive_size)) ||
      (encoding !== null && encoding !== 'identity')
    ) {
      await response.body.cancel();
      throw new Error('Unexpected C2PA download size or encoding');
    }
    await pipeline(
      Readable.fromWeb(response.body),
      integrityStream(asset.archive_size, asset.archive_sha256),
      fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      { signal }
    );
    return;
  }
}

function validateEntry(entry, asset) {
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    entry.fileName !== asset.entry_name ||
    (type !== 0 && type !== 0o100000) ||
    (entry.externalFileAttributes & 0x10) !== 0 ||
    (entry.generalPurposeBitFlag & 0x41) !== 0 ||
    ![0, 8].includes(entry.compressionMethod) ||
    entry.uncompressedSize !== asset.native_size ||
    entry.compressedSize > asset.archive_size
  ) {
    throw new Error('Unexpected C2PA ZIP entry');
  }
}

async function extractNative(archive, target, asset, signal) {
  signal.throwIfAborted();
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(
      archive,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, opened) => (error ? reject(error) : resolve(opened))
    );
  });
  await new Promise((resolve, reject) => {
    // Register before any close path. A close request only drops the reader's
    // reference; Windows cannot remove the temporary archive until fd close.
    const closed = new Promise((resolveClose, rejectClose) => {
      zip.once('close', resolveClose);
      zip.reader.once('error', rejectClose);
    });
    let finished = false;
    let extracted = false;
    let input;
    let transfer = Promise.resolve();
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input?.destroy(error);
      zip.close();
      signal.removeEventListener('abort', onAbort);
      Promise.all([transfer.catch(() => {}), closed]).then(
        () => (error ? reject(error) : resolve()),
        reject
      );
    };
    const onAbort = () => finish(signal.reason);
    zip.on('error', finish);
    zip.on('end', () =>
      finish(extracted ? undefined : new Error('Missing C2PA ZIP entry'))
    );
    zip.on('entry', (entry) => {
      try {
        if (extracted) throw new Error('Multiple C2PA ZIP entries');
        validateEntry(entry, asset);
      } catch (error) {
        finish(error);
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (finished) {
          stream?.destroy();
          return;
        }
        if (error) return finish(error);
        input = stream;
        transfer = pipeline(
          input,
          integrityStream(asset.native_size, asset.native_sha256),
          fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
          { signal }
        );
        transfer.then(() => {
          extracted = true;
          if (!finished) zip.readEntry();
        }, finish);
      });
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    if (zip.entryCount !== 1)
      return finish(new Error('Expected exactly one C2PA ZIP entry'));
    zip.readEntry();
  });
}

async function install({
  packageRoot = path.resolve(__dirname, '..'),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000
} = {}) {
  const manifestPath = path.join(packageRoot, 'scripts', 'native-assets.json');
  const manifestStat = await fsp.stat(manifestPath);
  if (manifestStat.size > 65536)
    throw new Error('C2PA asset manifest is too large');
  const asset = selectAsset(
    JSON.parse(await fsp.readFile(manifestPath, 'utf8')),
    platform,
    arch
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('C2PA installation timed out')),
    timeoutMs
  );
  const { signal } = controller;
  const directory = path.join(packageRoot, 'dist');
  let temporary;
  try {
    await fsp.mkdir(directory, { recursive: true });
    if (!(await fsp.lstat(directory)).isDirectory())
      throw new Error('Invalid C2PA dist directory');
    const destination = path.join(directory, 'index.node');
    if (await matchesNative(destination, asset, signal)) {
      await fsp.chmod(destination, 0o644);
      return { cached: true };
    }
    temporary = await fsp.mkdtemp(path.join(directory, '.c2pa-install-'));
    const archive = path.join(temporary, 'archive.zip');
    const native = path.join(temporary, 'index.node');
    await downloadArchive(asset, archive, fetchImpl, signal);
    await extractNative(archive, native, asset, signal);
    signal.throwIfAborted();
    await fsp.chmod(native, 0o644);
    await fsp.rename(native, destination);
    return { cached: false };
  } finally {
    clearTimeout(timeout);
    if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  install,
  selectAsset,
  integrityStream,
  downloadArchive,
  extractNative
};

if (require.main === module) {
  install().catch((error) => {
    console.error(`C2PA native installation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
