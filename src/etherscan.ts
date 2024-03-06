export async function getSourceCodeForContract(contract: string) {
  const f = await fetch(
    `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${contract}&apikey=${process.env.ETHERSCAN_API_KEY}`
  );
  const abi = await f.json();
  return abi;
}
