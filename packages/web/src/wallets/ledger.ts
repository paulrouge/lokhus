import Eth from '@ledgerhq/hw-app-eth'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import { getAddress, serializeTransaction, toHex, type Address, type Hex } from 'viem'
import { createChainClient, toViemChain, type ChainConfig, type EIP1193Provider, type WalletPlugin } from '@msa/core'
import { parseTypedData, typedDataHashes } from './typedDataHashes.ts'

const ICON =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="%23111"/><path d="M10 24v6h10v-1.6h-8.4V24H10Zm18.4 0v4.4H20V30h10v-6h-1.6ZM20 10v1.6h8.4V16H30v-6H20Zm-10 0v6h1.6v-4.4H20V10H10Zm6.4 5.2v9.6h7.2v-1.6h-5.6v-8h-1.6Z" fill="white"/></svg>'

const ACCOUNTS_TO_SCAN = 5
const INS_NOT_SUPPORTED = 0x6d00
const OFFLINE_CONFIG = { calServiceURL: null, cryptoassetsBaseURL: null, nftExplorerBaseURL: null, pluginBaseURL: null }

export type LedgerTypedDataDisplay = 'fields' | 'hashes'
export const ledgerTypedDataDisplay: { last: LedgerTypedDataDisplay | null } = { last: null }

const isUnsupported = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode === INS_NOT_SUPPORTED
const derivationPath = (index: number) => `44'/60'/${index}'/0/0`

const ledgerSignature = (r: string, s: string, v: number | string): Hex => {
  const recovery = typeof v === 'string' ? parseInt(v, 16) : v
  const normalized = recovery < 27 ? recovery + 27 : recovery
  return `0x${r}${s}${normalized.toString(16)}`
}

interface LedgerSession {
  eth: Eth
  path: string
  address: Address
  getChain: () => ChainConfig
}

const createLedgerProvider = ({ eth, path, address, getChain }: LedgerSession): EIP1193Provider => ({
  request: async ({ method, params }) => {
    const chain = getChain()
    const client = createChainClient(chain)
    const args = (params ?? []) as unknown[]

    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [address]
      case 'eth_chainId':
        return toHex(chain.chainId)
      case 'eth_signTypedData_v4': {
        const typed = parseTypedData(args[1])
        try {
          const result = await eth.signEIP712Message(path, typed as Parameters<Eth['signEIP712Message']>[1])
          ledgerTypedDataDisplay.last = 'fields'
          return ledgerSignature(result.r, result.s, result.v)
        } catch (error) {
          if (!isUnsupported(error)) throw error
        }
        const { domainHash, messageHash } = typedDataHashes(typed)
        const result = await eth.signEIP712HashedMessage(path, domainHash.slice(2), messageHash.slice(2))
        ledgerTypedDataDisplay.last = 'hashes'
        return ledgerSignature(result.r, result.s, result.v)
      }
      case 'personal_sign': {
        const message = args[0] as Hex
        const result = await eth.signPersonalMessage(path, message.slice(2))
        return ledgerSignature(result.r, result.s, result.v)
      }
      case 'eth_sendTransaction': {
        const request = args[0] as { to: Address; data?: Hex; value?: Hex }
        const prepared = await client.prepareTransactionRequest({
          account: address,
          chain: toViemChain(chain),
          to: request.to,
          data: request.data,
          value: request.value ? BigInt(request.value) : 0n,
          type: 'eip1559',
        })
        const tx = {
          type: 'eip1559' as const,
          chainId: chain.chainId,
          nonce: prepared.nonce,
          to: prepared.to,
          data: prepared.data,
          value: prepared.value,
          gas: prepared.gas,
          maxFeePerGas: prepared.maxFeePerGas,
          maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
        }
        const unsigned = serializeTransaction(tx)
        const result = await eth.signTransaction(path, unsigned.slice(2), null)
        const signed = serializeTransaction(tx, {
          r: `0x${result.r}`,
          s: `0x${result.s}`,
          yParity: parseInt(result.v, 16) % 2,
        })
        return client.sendRawTransaction({ serializedTransaction: signed })
      }
      default:
        return client.request({ method, params } as never)
    }
  },
})

export const ledgerPlugin: WalletPlugin = {
  id: 'ledger',
  label: 'Ledger',
  description: 'USB · open the Ethereum app first',
  icon: ICON,
  isAvailable: () => typeof navigator !== 'undefined' && 'usb' in navigator,
  connect: async ({ chain, ui }) => {
    const transport = await TransportWebUSB.create()
    try {
      const eth = new Eth(transport, undefined, OFFLINE_CONFIG)
      const choices = []
      for (let index = 0; index < ACCOUNTS_TO_SCAN; index++) {
        const { address } = await eth.getAddress(derivationPath(index))
        choices.push({ address: getAddress(address), label: `Account ${index + 1}` })
      }
      const picked = await ui.pickAccount(choices, { title: 'Choose a Ledger account' })
      const choice = choices[picked]
      if (!choice) throw new Error('No Ledger account selected')

      let activeChain = chain
      return {
        pluginId: 'ledger',
        address: choice.address,
        provider: createLedgerProvider({ eth, path: derivationPath(picked), address: choice.address, getChain: () => activeChain }),
        switchChain: async (target) => {
          activeChain = target
        },
        disconnect: () => transport.close(),
      }
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw error
    }
  },
}
