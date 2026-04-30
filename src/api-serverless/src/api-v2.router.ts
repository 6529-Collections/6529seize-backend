import { asyncRouter } from '@/api/async.router';
import dropsRoutes from './drops/drops-v2.routes';
import wavesRoutes from '@/api/waves/waves-v2.routes';

const router = asyncRouter();

router.use('/drops', dropsRoutes);
router.use('/waves', wavesRoutes);

export default router;
