import { asyncRouter } from '@/api/async.router';
import boostedDropsRoutes from '@/api/drops/boosted-drops-v2.routes';
import notificationsRoutes from '@/api/notifications/notifications-v2.routes';
import dropsRoutes from './drops/drops-v2.routes';
import wavesRoutes from '@/api/waves/waves-v2.routes';

const router = asyncRouter();

router.use('/boosted-drops', boostedDropsRoutes);
router.use('/drops', dropsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/waves', wavesRoutes);

export default router;
