import { Network } from '@/alchemy-sdk';
import { getRpcProvider } from '@/rpc-provider';
import { ethers } from 'ethers';

export const PROFILE_CMS_PUBLISH_EIP712_DOMAIN_NAME = '6529 Profile CMS';
export const PROFILE_CMS_PUBLISH_EIP712_DOMAIN_VERSION = '1';

const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const EIP1271_ABI = [
  'function isValidSignature(bytes32 _messageHash, bytes _signature) public view returns (bytes4)'
];

export interface ProfileCmsPublishSignatureRequest {
  readonly signer_address: string;
  readonly signature: string;
  readonly chain_id: number;
  readonly deadline: number;
  readonly is_safe_signature?: boolean;
  readonly verifying_contract?: string | null;
}

export interface ProfileCmsPublishTypedDataMessage {
  readonly action: 'publish';
  readonly profileId: string;
  readonly handle: string;
  readonly packageId: string;
  readonly version: number;
  readonly draftId: string;
  readonly payloadHash: string;
  readonly packageHash: string;
  readonly primaryPath: string;
  readonly storageProvider: string;
  readonly storageUri: string;
  readonly storageContentHash: string;
  readonly deadline: number;
}

export interface ProfileCmsPublishTypedData {
  readonly domain: ethers.TypedDataDomain;
  readonly types: Record<string, ethers.TypedDataField[]>;
  readonly message: ProfileCmsPublishTypedDataMessage;
}

export interface ProfileCmsPublishSignatureVerificationResult {
  readonly valid: boolean;
  readonly signer_address: string | null;
  readonly typed_data: ProfileCmsPublishTypedData;
  readonly typed_data_hash: string;
  readonly reason?: string;
}

export interface ProfileCmsPublishSignatureInput {
  readonly request: ProfileCmsPublishSignatureRequest;
  readonly message: ProfileCmsPublishTypedDataMessage;
}

export interface Eip1271SignatureVerifier {
  hasContractCode(params: {
    readonly contractAddress: string;
    readonly chainId: number;
  }): Promise<boolean>;
  isValidSignature(params: {
    readonly contractAddress: string;
    readonly chainId: number;
    readonly messageHash: string;
    readonly signature: string;
  }): Promise<boolean>;
}

export const PROFILE_CMS_PUBLISH_EIP712_TYPES: Record<
  string,
  ethers.TypedDataField[]
> = {
  ProfileCmsPublish: [
    { name: 'action', type: 'string' },
    { name: 'profileId', type: 'string' },
    { name: 'handle', type: 'string' },
    { name: 'packageId', type: 'string' },
    { name: 'version', type: 'uint256' },
    { name: 'draftId', type: 'string' },
    { name: 'payloadHash', type: 'string' },
    { name: 'packageHash', type: 'string' },
    { name: 'primaryPath', type: 'string' },
    { name: 'storageProvider', type: 'string' },
    { name: 'storageUri', type: 'string' },
    { name: 'storageContentHash', type: 'string' },
    { name: 'deadline', type: 'uint256' }
  ]
};

export function buildProfileCmsPublishTypedData(
  input: ProfileCmsPublishSignatureInput
): ProfileCmsPublishTypedData {
  return {
    domain: buildProfileCmsPublishDomain(input.request),
    types: PROFILE_CMS_PUBLISH_EIP712_TYPES,
    message: input.message
  };
}

export async function verifyProfileCmsPublishSignature(
  input: ProfileCmsPublishSignatureInput,
  safeVerifier: Eip1271SignatureVerifier = defaultEip1271SignatureVerifier
): Promise<ProfileCmsPublishSignatureVerificationResult> {
  const typedData = buildProfileCmsPublishTypedData(input);
  const typedDataHash = ethers.TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    typedData.message
  );
  const signerAddress = normalizeAddress(input.request.signer_address);
  if (!signerAddress) {
    return invalidResult(typedData, typedDataHash, 'invalid_signer_address');
  }

  if (input.request.is_safe_signature) {
    let valid = false;
    try {
      const hasContractCode = await safeVerifier.hasContractCode({
        contractAddress: signerAddress,
        chainId: input.request.chain_id
      });
      if (!hasContractCode) {
        return invalidResult(
          typedData,
          typedDataHash,
          'eip1271_signer_has_no_contract_code'
        );
      }
      valid = await safeVerifier.isValidSignature({
        contractAddress: signerAddress,
        chainId: input.request.chain_id,
        messageHash: typedDataHash,
        signature: input.request.signature
      });
    } catch {
      return invalidResult(
        typedData,
        typedDataHash,
        'eip1271_verification_failed'
      );
    }
    return {
      valid,
      signer_address: valid ? signerAddress : null,
      typed_data: typedData,
      typed_data_hash: typedDataHash,
      ...(valid ? {} : { reason: 'invalid_eip1271_signature' })
    };
  }

  try {
    const recovered = normalizeAddress(
      ethers.verifyTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
        input.request.signature
      )
    );
    return {
      valid: recovered === signerAddress,
      signer_address: recovered,
      typed_data: typedData,
      typed_data_hash: typedDataHash,
      ...(recovered === signerAddress
        ? {}
        : { reason: 'signer_address_mismatch' })
    };
  } catch {
    return invalidResult(typedData, typedDataHash, 'invalid_eoa_signature');
  }
}

function buildProfileCmsPublishDomain(
  request: ProfileCmsPublishSignatureRequest
): ethers.TypedDataDomain {
  const baseDomain: ethers.TypedDataDomain = {
    name: PROFILE_CMS_PUBLISH_EIP712_DOMAIN_NAME,
    version: PROFILE_CMS_PUBLISH_EIP712_DOMAIN_VERSION,
    chainId: request.chain_id
  };
  const verifyingContract = normalizeAddress(request.verifying_contract);
  return verifyingContract ? { ...baseDomain, verifyingContract } : baseDomain;
}

function invalidResult(
  typedData: ProfileCmsPublishTypedData,
  typedDataHash: string,
  reason: string
): ProfileCmsPublishSignatureVerificationResult {
  return {
    valid: false,
    signer_address: null,
    typed_data: typedData,
    typed_data_hash: typedDataHash,
    reason
  };
}

function normalizeAddress(address: string | null | undefined): string | null {
  if (!address || !ethers.isAddress(address)) {
    return null;
  }
  return ethers.getAddress(address).toLowerCase();
}

class DefaultEip1271SignatureVerifier implements Eip1271SignatureVerifier {
  async hasContractCode({
    contractAddress,
    chainId
  }: {
    readonly contractAddress: string;
    readonly chainId: number;
  }): Promise<boolean> {
    const code = await getRpcProvider(getRpcNetwork(chainId)).getCode(
      contractAddress
    );
    return code !== '0x';
  }

  async isValidSignature({
    contractAddress,
    chainId,
    messageHash,
    signature
  }: {
    readonly contractAddress: string;
    readonly chainId: number;
    readonly messageHash: string;
    readonly signature: string;
  }): Promise<boolean> {
    const contract = new ethers.Contract(
      contractAddress,
      EIP1271_ABI,
      getRpcProvider(getRpcNetwork(chainId))
    );
    const result = await contract.isValidSignature(messageHash, signature);
    return (
      typeof result === 'string' && result.toLowerCase() === EIP1271_MAGIC_VALUE
    );
  }
}

export const defaultEip1271SignatureVerifier =
  new DefaultEip1271SignatureVerifier();

function getRpcNetwork(chainId: number): Network {
  switch (chainId) {
    case 1:
      return Network.ETH_MAINNET;
    case 5:
      return Network.ETH_GOERLI;
    case 11155111:
      return Network.ETH_SEPOLIA;
    default:
      throw new Error(`Unsupported CMS publish EIP-1271 chain id ${chainId}`);
  }
}
