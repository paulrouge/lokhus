import { createWalletClient, custom, type Hex } from 'viem'
import { assertSafeTxRecord, safeTxTypedData, toViemChain, type ChainConfig, type MetaTx, type SafeTxRecord, type WalletConnection } from '@msa/core'
import { clientFor } from '../state/data.tsx'

const walletClient = (connection: WalletConnection, chain: ChainConfig) =>
  createWalletClient({ account: connection.address, chain: toViemChain(chain), transport: custom(connection.provider) })

export const signSafeTx = async (connection: WalletConnection, chain: ChainConfig, record: SafeTxRecord): Promise<Hex> => {
  assertSafeTxRecord(record)
  await connection.switchChain(chain)
  return walletClient(connection, chain).signTypedData({
    account: connection.address,
    ...safeTxTypedData(record.tx, record.safeAddress, chain.chainId),
  })
}

export const sendAndWait = async (connection: WalletConnection, chain: ChainConfig, call: MetaTx) => {
  await connection.switchChain(chain)
  const hash = await walletClient(connection, chain).sendTransaction({
    account: connection.address,
    chain: toViemChain(chain),
    to: call.to,
    data: call.data,
    value: BigInt(call.value),
  })
  const receipt = await clientFor(chain).waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`)
  return receipt
}

export const signMessageWith = async (connection: WalletConnection, chain: ChainConfig, message: string): Promise<Hex> => {
  await connection.switchChain(chain)
  return walletClient(connection, chain).signMessage({ account: connection.address, message })
}
