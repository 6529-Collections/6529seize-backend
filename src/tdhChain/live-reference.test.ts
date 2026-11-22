import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { siteHeaderTotals } from './chain-day-compare';
import { siteDayFromUploads } from './site-uploads';

/**
 * Known-good days: the live network's certified headers (STRONG and FINAL)
 * for cycle days 20778 and 20779, which 6529.io matched exactly, burn
 * addresses included. The uploads hold wallet addresses, so they stay out of
 * the repo: this test runs only when TDH_LIVE_UPLOADS_DIR names a folder with
 * `site-<YYYYMMDD>/walletCsv` and `consolidatedCsv` (the CLI's saved inputs).
 */
const LIVE_HEADERS = [
  {
    date: '20261121',
    cycleDay: 20778,
    cutoffNumber: 26459749,
    walletCount: 11184,
    identityCount: 10264,
    totalTdh: 2178149385
  },
  {
    date: '20261122',
    cycleDay: 20779,
    cutoffNumber: 26466924,
    walletCount: 11183,
    identityCount: 10261,
    totalTdh: 2181140658
  }
];

const dir = process.env.TDH_LIVE_UPLOADS_DIR;
const live = dir ? it : it.skip;

describe('live reference days', () => {
  for (const h of LIVE_HEADERS) {
    live(
      `6529.io's uploads of ${h.date} give cycle ${h.cycleDay}'s header`,
      () => {
        const folder = path.join(dir ?? '', `site-${h.date}`);
        expect(existsSync(folder)).toBe(true);
        const site = siteDayFromUploads(
          readFileSync(path.join(folder, 'walletCsv'), 'utf8'),
          readFileSync(path.join(folder, 'consolidatedCsv'), 'utf8')
        );
        expect(site.block).toBe(h.cutoffNumber);
        expect(site.date).toBe(h.date);
        expect(siteHeaderTotals(site)).toEqual({
          walletCount: h.walletCount,
          identityCount: h.identityCount,
          totalTdh: h.totalTdh
        });
      }
    );
  }
});
