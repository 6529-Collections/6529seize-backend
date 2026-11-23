'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRUSTED_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Absolute path of a system tool, looked up only in fixed system
 * directories so a writable PATH entry cannot substitute it. Windows
 * development machines resolve the name through PATH.
 */
function systemExecutable(name) {
  if (process.platform === 'win32') return name;
  const found = TRUSTED_BIN_DIRS.map((dir) => path.join(dir, name)).find(
    (candidate) => fs.existsSync(candidate)
  );
  if (!found) {
    throw new Error(
      `${name} is not installed in ${TRUSTED_BIN_DIRS.join(', ')}`
    );
  }
  return found;
}

function git(repoRoot, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const result = spawnSync(
    systemExecutable('git'),
    ['-c', 'core.quotePath=false', '-C', repoRoot, ...args],
    { encoding, maxBuffer: MAX_BUFFER, windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr;
    throw new Error(`git ${args[0]} failed: ${String(stderr).trim()}`);
  }
  return result.stdout;
}

function assertSha(sha, label = 'commit') {
  if (!SHA_PATTERN.test(sha || '')) {
    throw new Error(`${label} must be a full lowercase 40-character SHA`);
  }
}

function resolveCommit(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function hasCommit(repoRoot, sha) {
  return (
    git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`], {
      allowFailure: true
    }) !== null
  );
}

function isAncestor(repoRoot, ancestor, descendant) {
  return (
    git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true
    }) !== null
  );
}

function commitDate(repoRoot, sha) {
  return git(repoRoot, ['show', '-s', '--format=%cI', sha]).trim();
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * A read-only view of one commit's tree: object IDs by path and directory
 * listings, from a single `git ls-tree` call.
 */
function readTree(repoRoot, sha) {
  assertSha(sha);
  const output = git(repoRoot, [
    'ls-tree',
    '-r',
    '-t',
    '-z',
    '--full-tree',
    sha
  ]);
  const entries = new Map();
  const children = new Map([['', []]]);
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    entries.set(path, { type, oid });
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(`${type} ${path.slice(slash + 1)}`);
    if (type === 'tree' && !children.has(path)) children.set(path, []);
  }
  const listingHashes = new Map();
  return {
    sha,
    oid(path) {
      return entries.get(path)?.oid ?? null;
    },
    type(path) {
      return entries.get(path)?.type ?? null;
    },
    /** Names and types directly inside `dir` ('' is the repository root). */
    listingHash(dir) {
      if (!listingHashes.has(dir)) {
        const names = children.get(dir);
        listingHashes.set(
          dir,
          names
            ? hashText(names.slice().sort(compareText).join('\n'))
            : 'absent'
        );
      }
      return listingHashes.get(dir);
    },
    children(dir) {
      return (children.get(dir) || []).map((entry) => {
        const space = entry.indexOf(' ');
        return { type: entry.slice(0, space), name: entry.slice(space + 1) };
      });
    }
  };
}

function readBlob(repoRoot, oid) {
  return git(repoRoot, ['cat-file', 'blob', oid]);
}

/**
 * First-parent commits in `from..to` with the files each one changed
 * relative to its first parent, newest first.
 */
function firstParentChanges(repoRoot, from, to) {
  const output = git(repoRoot, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--name-only',
    '--format=%x1e%H%x1f%cI%x1f%s',
    `${from}..${to}`
  ]);
  return output
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [header, ...rest] = chunk.split('\n');
      const [sha, date, subject] = header.split('\x1f');
      return {
        sha,
        date,
        subject,
        files: rest.map((line) => line.trim()).filter(Boolean)
      };
    });
}

/** Writes `paths` of `sha` into `destination` with `git archive | tar`. */
function extractTree(repoRoot, sha, destination, paths) {
  assertSha(sha);
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    const archive = spawn(
      systemExecutable('git'),
      ['-C', repoRoot, 'archive', '--format=tar', sha, '--', ...paths],
      { windowsHide: true }
    );
    // Run tar inside the destination so no path argument is needed; GNU tar
    // would read a Windows drive letter as a remote host name.
    const tar = spawn(systemExecutable('tar'), ['-x', '-f', '-'], {
      cwd: destination,
      windowsHide: true
    });
    let stderr = '';
    archive.stderr.on('data', (chunk) => (stderr += chunk));
    tar.stderr.on('data', (chunk) => (stderr += chunk));
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    let failed = false;
    const done = (name) => (code) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`${name} exited ${code}: ${stderr.trim()}`));
      }
      pending -= 1;
      if (pending === 0 && !failed) resolve();
    };
    archive.on('error', reject);
    tar.on('error', reject);
    archive.on('close', done('git archive'));
    tar.on('close', done('tar'));
  });
}

module.exports = {
  SHA_PATTERN,
  systemExecutable,
  git,
  assertSha,
  resolveCommit,
  hasCommit,
  isAncestor,
  commitDate,
  hashText,
  readTree,
  readBlob,
  firstParentChanges,
  extractTree
};
