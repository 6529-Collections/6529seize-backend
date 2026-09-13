import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WalletTransferAnalysisError } from '@/wallet-transfer-analysis/types';
import { saveBackfillState } from './backfill-state';

const NOW = Date.UTC(2026, 8, 13);
const TEMP_PREFIX = 'wallet-backfill-state-test-';
const PRIVATE_MESSAGE = 'private-path credential=value SELECT private_data';
const originalWriteFile = fs.writeFile.bind(fs);

describe('backfill state persistence', () => {
  let directory: string;
  let statePath: string;
  let write: jest.SpyInstance<
    ReturnType<typeof fs.writeFile>,
    Parameters<typeof fs.writeFile>
  >;
  let rename: jest.SpyInstance<
    ReturnType<typeof fs.rename>,
    Parameters<typeof fs.rename>
  >;
  let sleep: jest.SpyInstance;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    statePath = join(directory, 'state.json');
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    write = jest.spyOn(fs, 'writeFile');
    rename = jest.spyOn(fs, 'rename');
    sleep = jest.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const cleanupDirectory = resolve(directory);
    if (
      dirname(cleanupDirectory) !== resolve(tmpdir()) ||
      !basename(cleanupDirectory).startsWith(TEMP_PREFIX)
    ) {
      throw new Error('Refusing to clean an unexpected test directory');
    }
    rmSync(cleanupDirectory, { recursive: true, force: true });
  });

  it('writes the whole state with a fresh timestamp and atomically replaces the old file', async () => {
    writeFileSync(statePath, '{"status":"starting"}\n');
    const state = { updated_at: 0, status: 'complete', last_block: 1_999 };

    await saveBackfillState(statePath, state);

    expect(state.updated_at).toBe(NOW);
    expect(readFileSync(statePath, 'utf8')).toBe(
      `${JSON.stringify(state, null, 2)}\n`
    );
    expect(write).toHaveBeenCalledWith(`${statePath}.tmp`, expect.any(String), {
      mode: 0o600
    });
    expect(rename).toHaveBeenCalledWith(`${statePath}.tmp`, statePath);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['EBUSY', 'EPERM', 'EACCES'])(
    'recovers from a transient %s temporary-write rejection, including a partial write',
    async (code) => {
      write.mockImplementationOnce(async (path, _contents, options) => {
        await originalWriteFile(path, '{"partial":', options);
        throw Object.assign(new Error(PRIVATE_MESSAGE), { code });
      });
      const state = { updated_at: 0, status: 'cooldown' };

      await saveBackfillState(statePath, state);

      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
      expect(write).toHaveBeenCalledTimes(2);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep.mock.calls.map((call) => call[1])).toEqual([50]);
    }
  );

  it.each(['EBUSY', 'EPERM', 'EACCES'])(
    'recovers from a transient %s plain-object replace rejection without rewriting',
    async (code) => {
      rename.mockRejectedValueOnce({ code, message: PRIVATE_MESSAGE });
      const state = { updated_at: 0, status: 'cooldown' };

      await saveBackfillState(statePath, state);

      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
      expect(write).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(sleep.mock.calls.map((call) => call[1])).toEqual([50]);
    }
  );

  it('bounds both operations to four attempts and 700 ms of combined backoff', async () => {
    for (const operation of [write, rename]) {
      operation
        .mockRejectedValueOnce({ code: 'EBUSY' })
        .mockRejectedValueOnce({ code: 'EPERM' })
        .mockRejectedValueOnce({ code: 'EACCES' });
    }

    await saveBackfillState(statePath, { updated_at: 0 });

    expect(write).toHaveBeenCalledTimes(4);
    expect(rename).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[1])).toEqual([
      50, 100, 200, 50, 100, 200
    ]);
  });

  it.each(['write', 'replace'] as const)(
    'stops after four persistent transient %s failures without damaging complete state',
    async (operation) => {
      const oldContents = '{"updated_at":1,"status":"complete"}\n';
      writeFileSync(statePath, oldContents);
      const failed = operation === 'write' ? write : rename;
      failed.mockRejectedValue(
        Object.assign(new Error(PRIVATE_MESSAGE), { code: 'EBUSY' })
      );

      await expect(
        saveBackfillState(statePath, { updated_at: 0 })
      ).rejects.toThrow(
        new WalletTransferAnalysisError(
          `Backfill state ${operation === 'write' ? 'temporary write' : 'replace'} failed (EBUSY)`
        )
      );

      expect(failed).toHaveBeenCalledTimes(4);
      expect(readFileSync(statePath, 'utf8')).toBe(oldContents);
      expect(sleep.mock.calls.map((call) => call[1])).toEqual([50, 100, 200]);
      if (operation === 'write') expect(rename).not.toHaveBeenCalled();
      else {
        expect(write).toHaveBeenCalledTimes(1);
        expect(JSON.parse(readFileSync(`${statePath}.tmp`, 'utf8'))).toEqual({
          updated_at: NOW
        });
      }
    }
  );

  it.each([
    'ENOSPC',
    'EROFS',
    'ENOENT',
    'ENOTDIR',
    'EISDIR',
    'EMFILE',
    'ENFILE',
    'EIO'
  ])(
    'reports permanent %s errors without retry or raw diagnostics',
    async (code) => {
      write.mockRejectedValue({
        code,
        message: PRIVATE_MESSAGE,
        path: statePath
      });

      const error: unknown = await saveBackfillState(statePath, {
        updated_at: 0
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(WalletTransferAnalysisError);
      expect(error).toHaveProperty(
        'message',
        `Backfill state temporary write failed (${code})`
      );
      expect(write).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it('does not retry a permanent replace failure or expose its message', async () => {
    rename.mockRejectedValue({ code: 'EROFS', message: PRIVATE_MESSAGE });

    await expect(
      saveBackfillState(statePath, { updated_at: 0 })
    ).rejects.toThrow('Backfill state replace failed (EROFS)');

    expect(write).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    new Error(`EBUSY ${PRIVATE_MESSAGE}`),
    { code: `EBUSY ${PRIVATE_MESSAGE}` },
    { code: 'ebusy' },
    { code: 16 },
    { code: 'ER_LOCK_DEADLOCK', message: PRIVATE_MESSAGE },
    PRIVATE_MESSAGE,
    null,
    undefined
  ])(
    'sanitizes unsupported error shape %# and never retries it',
    async (failure) => {
      write.mockRejectedValue(failure);

      const error: unknown = await saveBackfillState(statePath, {
        updated_at: 0
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WalletTransferAnalysisError);
      expect(error).toHaveProperty(
        'message',
        'Backfill state temporary write failed (UNKNOWN)'
      );
      expect(write).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it('ignores error-code accessors without executing arbitrary diagnostic code', async () => {
    const code = jest.fn(() => {
      throw new Error(PRIVATE_MESSAGE);
    });
    write.mockRejectedValue(Object.defineProperty({}, 'code', { get: code }));

    await expect(
      saveBackfillState(statePath, { updated_at: 0 })
    ).rejects.toThrow('Backfill state temporary write failed (UNKNOWN)');

    expect(code).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
