type InternalEthTransfer = {
  from: string;
  to: string;
  value: number;
};

export async function getInternalEthTransfers(
  txHash: string
): Promise<InternalEthTransfer[]> {
  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }

  const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'trace_transaction',
      params: [txHash]
    })
  });

  if (!res.ok) {
    throw new Error(
      `Alchemy trace_transaction failed: ${res.status} ${await res.text()}`
    );
  }

  const json = (await res.json()) as { error?: unknown; result?: unknown[] };

  if (json.error) {
    throw new Error(
      `Alchemy trace_transaction error: ${JSON.stringify(json.error)}`
    );
  }

  return (json.result as any[])
    .filter(
      (t) =>
        t.type === 'call' &&
        t.action?.value &&
        BigInt(t.action.value) > BigInt(0)
    )
    .map((t) => ({
      from: t.action.from as string,
      to: t.action.to as string,
      value: Number(BigInt(t.action.value)) / 1e18
    }));
}
