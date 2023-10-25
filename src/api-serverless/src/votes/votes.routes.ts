import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as votes from '../../../votes';
import * as Joi from 'joi';
import { VoteCategoryInfo } from '../../../votes';
import { VoteMatterTargetType } from '../../../entities/IVoteMatter';
import { getWalletOrNull, needsAuthenticatedUser } from '../auth/auth';
import { WALLET_REGEX } from '../../../constants';
import { ForbiddenException } from '../../../exceptions';
import { asyncRouter } from '../async.router';
import { getValidatedByJoiOrThrow } from '../validation';

const router = asyncRouter();

router.get(
  `/targets/:matter_target_type/:matter_target_id/matters/:matter`,
  async function (
    req: Request<
      {
        matter_target_id: string;
        matter_target_type: VoteMatterTargetType;
        matter: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<WalletStateOnMattersVoting>>
  ) {
    const { matter, matter_target_type, matter_target_id } = req.params;
    const wallet = getWalletOrNull(req);
    const { votesLeft, consolidatedWallets } = wallet
      ? await votes.getVotesLeftOnMatterForWallet({
          wallet,
          matter,
          matterTargetType: matter_target_type
        })
      : { votesLeft: 0, consolidatedWallets: [] as string[] };
    const categoriesInfo = await votes.getCategoriesInfoOnMatter({
      wallets: consolidatedWallets,
      matter,
      matterTargetType: matter_target_type,
      matterTargetId: matter_target_id
    });
    res.status(200).send({
      votes_left: votesLeft,
      categories: categoriesInfo
    });
  }
);

router.post(
  `/targets/:matter_target_type/:matter_target_id/matters/:matter`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        matter_target_id: string;
        matter_target_type: VoteMatterTargetType;
        matter: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<void>>
  ) {
    const walletFromHeader = getWalletOrNull(req);
    const { matter, matter_target_type, matter_target_id } = req.params;
    const { amount, category, voter_wallet } = req.body as ApiVoteRequestBody;
    if (walletFromHeader !== voter_wallet) {
      console.error(
        `[API] [VOTES] Voter failed to vote on path (target_type=${matter_target_type}; matter=${matter}; category=${category}}) because wallet from auth '${walletFromHeader}' and wallet in body '${voter_wallet}' did not match`
      );
      throw new ForbiddenException(
        'Something went wrong. User is not allowed to vote.'
      );
    }
    const voteRequest = getValidatedByJoiOrThrow(
      {
        voterWallet: voter_wallet,
        matter,
        matterTargetType: matter_target_type,
        matterTargetId: matter_target_id,
        category: category,
        amount: amount
      },
      WalletVoteRequestSchema
    );
    await votes.registerUserVote(voteRequest);
    res.status(201).send();
  }
);

interface ApiVoteRequestBody {
  voter_wallet: string;
  amount: number;
  category: string;
}

const WalletVoteRequestSchema = Joi.object<{
  voterWallet: string;
  matter: string;
  matterTargetType: VoteMatterTargetType;
  matterTargetId: string;
  category: string;
  amount: number;
}>({
  voterWallet: Joi.string().regex(WALLET_REGEX).required(),
  matter: Joi.string().required(),
  matterTargetType: Joi.string()
    .valid(...Object.values(VoteMatterTargetType))
    .required(),
  matterTargetId: Joi.string()
    .when('matterTargetType', {
      is: VoteMatterTargetType.WALLET,
      then: Joi.string().regex(WALLET_REGEX).required()
    })
    .required(),
  category: Joi.string().required(),
  amount: Joi.number().integer().options({ convert: false })
});

export interface WalletStateOnMattersVoting {
  votes_left: number;
  categories: VoteCategoryInfo[];
}

export default router;
