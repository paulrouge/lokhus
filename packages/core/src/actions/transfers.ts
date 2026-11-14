import { encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits } from 'viem'
import type { ActionPlugin } from '../plugins.ts'
import { erc20Abi } from '../safe/abi.ts'

const requireAddress = (value: string | undefined, label: string) => {
  if (!value || !isAddress(value)) throw new Error(`${label} is not a valid address`)
  return getAddress(value)
}

const requireAmount = (value: string | undefined, decimals: number) => {
  const amount = parseUnits((value ?? '').trim() || '0', decimals)
  if (amount <= 0n) throw new Error('Amount must be greater than zero')
  return amount
}

export const nativeTransfer: ActionPlugin = {
  id: 'native-transfer',
  label: 'Send native coin',
  description: 'Send the chain’s native coin from the Safe.',
  supports: () => true,
  fields: ({ chain }) => [
    { name: 'to', label: 'Recipient', type: 'address', placeholder: '0x…' },
    { name: 'amount', label: `Amount (${chain.nativeSymbol})`, type: 'amount', placeholder: '0.0' },
  ],
  build: async (input, { chain }) => {
    const to = requireAddress(input.to, 'Recipient')
    const amount = requireAmount(input.amount, 18)
    return {
      calls: [{ to, value: amount.toString(), data: '0x' }],
      summary: `Send ${formatUnits(amount, 18)} ${chain.nativeSymbol} to ${to}`,
    }
  },
}

export const tokenTransfer: ActionPlugin = {
  id: 'token-transfer',
  label: 'Send token',
  description: 'Send an ERC-20 token from the Safe.',
  supports: (chain) => chain.tokens.length > 0,
  fields: () => [
    { name: 'token', label: 'Token', type: 'token' },
    { name: 'to', label: 'Recipient', type: 'address', placeholder: '0x…' },
    { name: 'amount', label: 'Amount', type: 'amount', placeholder: '0.0' },
  ],
  build: async (input, { chain }) => {
    const tokenAddress = requireAddress(input.token, 'Token')
    const token = chain.tokens.find((candidate) => candidate.address.toLowerCase() === tokenAddress.toLowerCase())
    if (!token) throw new Error('Token is not configured for this chain')
    const to = requireAddress(input.to, 'Recipient')
    const amount = requireAmount(input.amount, token.decimals)
    return {
      calls: [
        {
          to: token.address,
          value: '0',
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        },
      ],
      summary: `Send ${formatUnits(amount, token.decimals)} ${token.symbol} to ${to}`,
    }
  },
}
