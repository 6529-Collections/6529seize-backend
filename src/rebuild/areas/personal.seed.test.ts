import type { RebuildContext } from '@/rebuild/manifest.types';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import { seedPersonalSettings } from './personal.seed';

describe('seedPersonalSettings', () => {
  it("takes the records wave 'none' or unset as no records wave, and writes nothing", async () => {
    const ctx = { seedFilesDir: 'unused' } as unknown as RebuildContext;
    for (const wave of ['none', 'NONE', '']) {
      await expect(
        seedPersonalSettings(ctx, {
          ...personalManifest.flags,
          SIGNED_RECORDS_WAVE_ID: wave
        })
      ).rejects.toThrow('no records wave set');
    }
  });
});
