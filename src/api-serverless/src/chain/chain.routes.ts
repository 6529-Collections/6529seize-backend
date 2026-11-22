import { Request, Response } from 'express';
import * as Joi from 'joi';
import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { getValidatedByJoiOrThrow } from '../validation';
import { chainRelayService } from '@/chain-relay/chain-relay.service';
import { PendingOperation } from '@/chain-relay/chain-pending-operations.db';
import { ChainSubmitRequest } from '@/chain-gateway/chain-gateway.types';

/**
 * Operations people sign with their wallets for the 6529 chain: relayed to
 * the chain, or held until every wallet an operation needs has signed (an
 * identity join needs the identity's wallet and the joining wallet). Drafts
 * come from the chain gateway (POST /v1/draft); the wallet signs its typed
 * data; the signatures come here.
 */
const router = asyncRouter();

interface SignatureBody {
  readonly role: number;
  readonly key_type: number;
  readonly sig: string;
}

const SignatureSchema = Joi.object<SignatureBody>({
  role: Joi.number().integer().min(0).max(255).required(),
  key_type: Joi.number().integer().valid(1).required(),
  sig: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{130}$/)
    .required()
});

interface SubmitBody {
  readonly signed?: string;
  readonly unsigned?: string;
  readonly signatures?: SignatureBody[];
}

/** Either the whole signed operation, or its unsigned bytes and signatures. */
const SubmitSchema = Joi.object<SubmitBody>({
  signed: Joi.string().pattern(/^0x[0-9a-fA-F]+$/),
  unsigned: Joi.string().pattern(/^0x[0-9a-fA-F]+$/),
  signatures: Joi.array().items(SignatureSchema).min(1).max(8)
})
  .xor('signed', 'unsigned')
  .with('unsigned', 'signatures')
  .without('signed', 'signatures');

interface PendingBody {
  readonly tx_id: string;
  readonly op_type: string | number;
  readonly principal: string | null;
  readonly unsigned: string;
  readonly expires_at: number;
  readonly required: { role: number; key_type: number; signer: string }[];
  readonly signatures: SignatureBody[];
}

const PendingSchema = Joi.object<PendingBody>({
  tx_id: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{64}$/)
    .required(),
  op_type: Joi.alternatives()
    .try(Joi.string().max(50), Joi.number().integer().min(0))
    .required(),
  principal: Joi.string()
    .pattern(/^0x[0-9a-fA-F]{64}$/)
    .allow(null)
    .required(),
  unsigned: Joi.string()
    .pattern(/^0x[0-9a-fA-F]+$/)
    .required(),
  expires_at: Joi.number().integer().required(),
  required: Joi.array()
    .items(
      Joi.object({
        role: Joi.number().integer().min(0).max(255).required(),
        key_type: Joi.number().integer().valid(1).required(),
        signer: Joi.string()
          .pattern(/^0x[0-9a-fA-F]{40}$/)
          .required()
      })
    )
    .min(1)
    .max(4)
    .required(),
  signatures: Joi.array().items(SignatureSchema).min(1).max(4).required()
});

const toSignature = (it: SignatureBody) => ({
  role: it.role,
  keyType: it.key_type,
  sig: it.sig
});

export function toApiPendingOperation(op: PendingOperation) {
  return {
    tx_id: op.tx_id,
    op_type: op.op_type,
    principal: op.principal,
    unsigned: op.unsigned_hex,
    created_by: op.created_by,
    expires_at: op.expires_at,
    status: op.status,
    result: op.result_json ? JSON.parse(op.result_json) : null,
    last_error: op.last_error,
    created_at: op.created_at,
    updated_at: op.updated_at,
    signers: op.signers.map((it) => ({
      role: it.role,
      key_type: it.key_type,
      signer: it.signer,
      signed: !!it.sig,
      sig: it.sig
    }))
  };
}

router.post(
  '/submit',
  needsAuthenticatedUser(),
  async (req: Request<any, any, SubmitBody>, res: Response) => {
    getWalletOrThrow(req);
    const body = getValidatedByJoiOrThrow(req.body, SubmitSchema);
    const request: ChainSubmitRequest = body.signed
      ? { signed: body.signed }
      : {
          unsigned: body.unsigned!,
          signatures: body.signatures!.map(toSignature)
        };
    res.send(await chainRelayService.submit(request));
  }
);

router.get('/pending', needsAuthenticatedUser(), async (req, res) => {
  const wallet = getWalletOrThrow(req);
  const ops = await chainRelayService.awaiting(wallet);
  res.send({ data: ops.map(toApiPendingOperation) });
});

router.post(
  '/pending',
  needsAuthenticatedUser(),
  async (req: Request<any, any, PendingBody>, res: Response) => {
    const wallet = getWalletOrThrow(req);
    const body = getValidatedByJoiOrThrow(req.body, PendingSchema);
    const op = await chainRelayService.createPending(
      {
        txId: body.tx_id,
        opType: body.op_type,
        principal: body.principal,
        unsigned: body.unsigned,
        expiresAt: body.expires_at,
        required: body.required.map((it) => ({
          role: it.role,
          keyType: it.key_type,
          signer: it.signer
        })),
        signatures: body.signatures.map(toSignature)
      },
      wallet
    );
    res.status(201).send(toApiPendingOperation(op));
  }
);

router.get(
  '/pending/:tx_id',
  needsAuthenticatedUser(),
  async (req: Request<{ tx_id: string }>, res: Response) => {
    getWalletOrThrow(req);
    res.send(
      toApiPendingOperation(await chainRelayService.get(req.params.tx_id))
    );
  }
);

router.post(
  '/pending/:tx_id/signatures',
  needsAuthenticatedUser(),
  async (
    req: Request<{ tx_id: string }, any, SignatureBody>,
    res: Response
  ) => {
    const wallet = getWalletOrThrow(req);
    const body = getValidatedByJoiOrThrow(req.body, SignatureSchema);
    const op = await chainRelayService.addSignature(
      req.params.tx_id,
      toSignature(body),
      wallet
    );
    res.send(toApiPendingOperation(op));
  }
);

router.post(
  '/pending/:tx_id/retry',
  needsAuthenticatedUser(),
  async (req: Request<{ tx_id: string }>, res: Response) => {
    const wallet = getWalletOrThrow(req);
    res.send(
      toApiPendingOperation(
        await chainRelayService.retry(req.params.tx_id, wallet)
      )
    );
  }
);

router.delete(
  '/pending/:tx_id',
  needsAuthenticatedUser(),
  async (req: Request<{ tx_id: string }>, res: Response) => {
    const wallet = getWalletOrThrow(req);
    res.send(
      toApiPendingOperation(
        await chainRelayService.cancel(req.params.tx_id, wallet)
      )
    );
  }
);

export default router;
