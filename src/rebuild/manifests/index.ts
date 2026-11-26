import { AreaManifest } from '@/rebuild/manifest.types';
import { identityManifest } from '@/rebuild/manifests/identity.manifest';
import { wavesManifest } from '@/rebuild/manifests/waves.manifest';
import { tdhManifest } from '@/rebuild/manifests/tdh.manifest';
import { holdingsManifest } from '@/rebuild/manifests/holdings.manifest';
import { subsManifest } from '@/rebuild/manifests/subs.manifest';
import { mintManifest } from '@/rebuild/manifests/mint.manifest';
import { publishManifest } from '@/rebuild/manifests/publish.manifest';
import { personalManifest } from '@/rebuild/manifests/personal.manifest';
import { dmManifest } from '@/rebuild/manifests/dm.manifest';
import { notifyManifest } from '@/rebuild/manifests/notify.manifest';
import { artdocManifest } from '@/rebuild/manifests/artdoc.manifest';
import { harnessManifest } from '@/rebuild/manifests/harness.manifest';

/** Every area's manifest. An area edits only its own file. */
export const AREA_MANIFESTS: readonly AreaManifest[] = [
  identityManifest,
  wavesManifest,
  tdhManifest,
  holdingsManifest,
  subsManifest,
  mintManifest,
  publishManifest,
  personalManifest,
  dmManifest,
  notifyManifest,
  artdocManifest,
  harnessManifest
];
