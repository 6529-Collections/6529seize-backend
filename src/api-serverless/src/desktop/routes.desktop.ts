import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import * as db from './db.desktop';

const router = asyncRouter();

export default router;

router.get('/splash', async (req: Request, res: Response) => {
  const rows = await db.fetchRandomVerticalImage();
  const row = rows[0];
  if (!row) {
    return res.status(404).json({ error: 'No vertical image found' });
  }
  return res.json({
    id: row.id,
    name: row.name,
    artist: row.artist,
    artist_seize_handle: row.artist_seize_handle,
    season: row.season,
    width: row.width,
    height: row.height,
    icon: row.icon,
    thumbnail: row.thumbnail,
    scaled: row.scaled,
    image: row.image
  });
});
