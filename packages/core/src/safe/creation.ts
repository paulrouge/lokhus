import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type PublicClient,
} from 'viem'
import type { Address, ChainConfig, Hex, MetaTx, SafeCreation, SafeRecord } from '../types.ts'
import { canonicalSafeContracts, isDeployed } from './onchain.ts'
import { creationSetup, safeDeploymentTx } from './deploy.ts'

const factoryAbi = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function proxyCreationCode() pure returns (bytes)',
])
const setupAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
])
const CREATE_SELECTOR = toFunctionSelector('createProxyWithNonce(address,bytes,uint256)').slice(2)
const CHAIN_SPECIFIC_SELECTOR = toFunctionSelector('createChainSpecificProxyWithNonce(address,bytes,uint256)').slice(2)
const PROXY_CREATION = toEventSelector('ProxyCreation(address,address)')

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const creationOwners = (creation: SafeCreation) => {
  const { args } = decodeFunctionData({ abi: setupAbi, data: creation.initializer })
  return { owners: args[0].map((owner) => getAddress(owner)), threshold: Number(args[1]) }
}

export const creationTx = (creation: SafeCreation): MetaTx => ({
  to: creation.factory,
  value: '0',
  data: encodeFunctionData({
    abi: factoryAbi,
    functionName: 'createProxyWithNonce',
    args: [creation.singleton, creation.initializer, BigInt(creation.saltNonce)],
  }),
})

export const creationFromTx = (tx: MetaTx): SafeCreation => {
  const { args } = decodeFunctionData({ abi: factoryAbi, data: tx.data })
  if (args.length !== 3) throw new Error('Not a createProxyWithNonce call')
  return { factory: getAddress(tx.to), singleton: getAddress(args[0]), initializer: args[1], saltNonce: args[2].toString() }
}

export const creationAddress = async (client: PublicClient, creation: SafeCreation): Promise<Address> => {
  if (!(await isDeployed(client, creation.factory))) throw new Error(`No Safe factory at ${creation.factory}`)
  const proxyCode = await client.readContract({ address: creation.factory, abi: factoryAbi, functionName: 'proxyCreationCode' })
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(creation.initializer), BigInt(creation.saltNonce)]))
  return getContractAddress({ opcode: 'CREATE2', from: creation.factory, salt, bytecode: concat([proxyCode, pad(creation.singleton)]) })
}

export const checkCreationOn = async (client: PublicClient, chainId: number, creation: SafeCreation, expected: Address) => {
  if (!canonicalSafeContracts(chainId).singletons.includes(creation.singleton.toLowerCase()))
    throw new Error(`Safe code ${creation.singleton} is not an official Safe singleton on this chain`)
  if (!(await isDeployed(client, creation.singleton))) throw new Error(`No Safe code at ${creation.singleton} on this chain`)
  const address = await creationAddress(client, creation)
  if (!sameAddress(address, expected)) throw new Error(`Would land at ${address}, not ${expected}`)
}

const findDeployBlock = async (client: PublicClient, address: Address) => {
  let high = await client.getBlockNumber({ cacheTime: 0 })
  let low = 0n
  while (low < high) {
    const mid = (low + high) / 2n
    const code = await client.getCode({ address, blockNumber: mid }).catch(() => {
      throw new Error('This RPC cannot read old blocks, so the Safe’s creation can’t be found. Add an archive RPC for this chain.')
    })
    if (code && code !== '0x') high = mid
    else low = mid + 1n
  }
  return low
}

const embeddedCalls = (input: Hex) => {
  const hex = input.slice(2).toLowerCase()
  const calls: Hex[] = []
  for (let index = hex.indexOf(CREATE_SELECTOR); index !== -1; index = hex.indexOf(CREATE_SELECTOR, index + 1)) {
    if (index % 2 === 0) calls.push(`0x${hex.slice(index)}`)
  }
  return calls
}

export const findCreation = async (
  client: PublicClient,
  address: Address,
  hint: { txHash?: Hex; block?: bigint } = {},
): Promise<SafeCreation> => {
  const candidates = hint.txHash ? [hint.txHash] : await creationCandidates(client, address, hint.block)
  for (const txHash of candidates) {
    const creation = await creationIn(client, address, txHash)
    if (creation) return creation
  }
  throw new Error(`Could not read how ${address} was created`)
}

const creationCandidates = async (client: PublicClient, address: Address, hintBlock?: bigint) => {
  const block = hintBlock ?? (await findDeployBlock(client, address))
  const logs = await client.getLogs({ address, fromBlock: block, toBlock: block })
  const hashes = [...new Set(logs.map((log) => log.transactionHash).filter((hash): hash is Hex => !!hash))]
  if (hashes.length === 0) throw new Error(`No setup log for ${address} in block ${block}`)
  return hashes
}

const creationIn = async (client: PublicClient, address: Address, txHash: Hex): Promise<SafeCreation | null> => {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })])
  const padded = pad(address).toLowerCase()
  const creationLog = receipt.logs.find(
    (log) => log.topics[0] === PROXY_CREATION && (log.topics[1]?.toLowerCase() === padded || log.data.toLowerCase().startsWith(padded)),
  )
  if (!creationLog) return null
  const factory = getAddress(creationLog.address)
  if (tx.input.toLowerCase().includes(CHAIN_SPECIFIC_SELECTOR))
    throw new Error('This Safe was created with a chain-specific address, so it cannot exist at the same address on other chains')
  for (const data of embeddedCalls(tx.input)) {
    try {
      const creation = { ...creationFromTx({ to: factory, value: '0', data }), txHash }
      if (sameAddress(await creationAddress(client, creation), address)) return creation
    } catch {
      continue
    }
  }
  throw new Error(`Could not read how ${address} was created from ${txHash}`)
}

export const resolveCreation = async (client: PublicClient, chain: ChainConfig, safe: SafeRecord): Promise<SafeCreation> => {
  if (!safe.address) throw new Error('Safe is not deployed')
  const address = safe.address
  const verified = async (creation: SafeCreation) => {
    if (!sameAddress(await creationAddress(client, creation), address)) throw new Error(`Saved creation does not give ${address}`)
    return creation
  }
  if (safe.creation) return verified(safe.creation)
  const setup = await creationSetup(chain, safe).catch(() => null)
  if (setup) return verified({ ...creationFromTx(await safeDeploymentTx(chain, setup)), txHash: safe.deployTxHash })
  return findCreation(client, address, { txHash: safe.deployTxHash, block: safe.deployBlock ? BigInt(safe.deployBlock) : undefined })
}
