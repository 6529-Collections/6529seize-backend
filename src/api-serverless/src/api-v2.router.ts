import { asyncRouter } from '@/api/async.router';
import dropsRoutes from './drops/drops-v2.routes';

const router = asyncRouter();

router.use('/drops', dropsRoutes);

export default router;
