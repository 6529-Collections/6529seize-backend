import { NextFunction, Request, Response } from 'express';
import { competitionRepository } from '@/competitions/competition.repository';

/** A competition path whose competition id is a chain id (0x, 64 hex). */
const CHAIN_COMPETITION_PATH =
  /^(\/v3\/waves\/[^/?#]+\/competitions\/)(0x[0-9a-fA-F]{64})(?=[/?#]|$)/;

/**
 * Lets every v3 competition route take a decision's chain id in place of
 * its competition id: the path is rewritten to 6529.io's id (an imported
 * decision's own, else the UUID a decision made on the chain is stored
 * under) before the routes match it, so their checks and reads are the
 * same either way.
 */
export function competitionChainIdPaths(
  repository: Pick<
    typeof competitionRepository,
    'findCompetitionIdOfChainId'
  > = competitionRepository
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const match = CHAIN_COMPETITION_PATH.exec(req.url);
    if (!match) {
      next();
      return;
    }
    try {
      const id = await repository.findCompetitionIdOfChainId(match[2], {});
      req.url = `${match[1]}${id}${req.url.slice(match[0].length)}`;
      next();
    } catch (error) {
      next(error);
    }
  };
}
