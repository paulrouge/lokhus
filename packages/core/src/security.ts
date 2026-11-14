import { getAddress, parseAbi, slice, type PublicClient } from 'viem'
import type { Address } from './types.ts'
import { SAFE_MULTISEND_CALL_ONLY } from './safe/tx.ts'

export type ContractGroup = 'safe' | 'sodax'

export interface TrustedContract {
  id: string
  name: string
  group: ContractGroup
  chainId: number
  address: Address
  role: string
  pinnedImplementation?: Address
  pinnedAt?: string
  upgradeOwnerSource?: Address
}

export interface AuditReport {
  title: string
  scope: string
  date?: string
  url: string
}

export type ControllerKind = 'immutable' | 'missing' | 'safe' | 'timelock' | 'eoa' | 'contract'

export interface ContractInspection {
  implementation: Address | null
  controller: Address | null
  controllerKind: ControllerKind
  controllerThreshold?: number
  controllerOwners?: number
  timelockDelaySeconds?: number
  changedSincePin: boolean
}

export const SODAX_LENDING_ADDRESSES_PROVIDER: Address = '0x036aDe0aBAA4c82445Cb7597f2d6d6130C118c7b'

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const PINNED_AT = '2026-11-11'
const SPOKES_PINNED_AT = '2026-11-12'

const inspectAbi = parseAbi([
  'function owner() view returns (address)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getMinDelay() view returns (uint256)',
  'function getACLAdmin() view returns (address)',
])

const sodax = (
  chainId: number,
  id: string,
  name: string,
  address: Address,
  role: string,
  implementation: Address,
  upgradeOwnerSource?: Address,
  pinnedAt = PINNED_AT,
): TrustedContract => ({
  upgradeOwnerSource,
  id,
  name,
  group: 'sodax',
  chainId,
  address,
  role,
  pinnedImplementation: implementation,
  pinnedAt,
})

const safe = (chainId: number, id: string, name: string, address: Address, role: string): TrustedContract => ({
  id: `${id}-${chainId}`,
  name,
  group: 'safe',
  chainId,
  address,
  role,
})

export const TRUSTED_CONTRACTS: TrustedContract[] = [
  ...[137, 146, 8453, 1].flatMap((chainId) => [
    safe(
      chainId,
      'safe-l2',
      'Safe L2 1.4.1 singleton',
      '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
      'The logic every Safe proxy runs',
    ),
    safe(chainId, 'proxy-factory', 'Safe proxy factory 1.4.1', '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', 'Deploys new Safes'),
    safe(
      chainId,
      'multisend',
      'MultiSendCallOnly 1.4.1',
      SAFE_MULTISEND_CALL_ONLY.address,
      'Batches several calls into one Safe transaction',
    ),
    safe(
      chainId,
      'fallback',
      'Compatibility fallback handler 1.4.1',
      '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
      'Signature and token-receiver callbacks',
    ),
  ]),
  sodax(
    137,
    'sodax-asset-manager-polygon',
    'SODAX AssetManager',
    '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    'Holds tokens deposited on Polygon for swaps and supplies',
    '0xb5239140745067502ee35B4E2dC2869418Db8309',
  ),
  sodax(
    137,
    'sodax-connection-polygon',
    'SODAX Connection',
    '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD',
    'Sends messages to the hub (withdrawals)',
    '0x8224b8d5423fE67e847Dadd343f0702231Ab6a3D',
  ),
  sodax(
    8453,
    'sodax-asset-manager-base',
    'SODAX AssetManager',
    '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3',
    'Holds tokens deposited on Base for swaps and supplies',
    '0x79F9B344bB64aF1E89B0C3d20ded4f299F4ff262',
    undefined,
    SPOKES_PINNED_AT,
  ),
  sodax(
    8453,
    'sodax-connection-base',
    'SODAX Connection',
    '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD',
    'Sends messages to the hub (withdrawals)',
    '0xaD7611B88616a301697b0dc551bBFB3625520bF6',
    undefined,
    SPOKES_PINNED_AT,
  ),
  sodax(
    1,
    'sodax-asset-manager-ethereum',
    'SODAX AssetManager',
    '0x39E77f86C1B1f3fbAb362A82b49D2E86C09659B4',
    'Holds tokens deposited on Ethereum for swaps and supplies',
    '0x8a5276fc345bba81C8063911e307E069879Cb17E',
    undefined,
    SPOKES_PINNED_AT,
  ),
  sodax(
    1,
    'sodax-connection-ethereum',
    'SODAX Connection',
    '0x4555aC13D7338D9E671584C1D118c06B2a3C88eD',
    'Sends messages to the hub (withdrawals)',
    '0x5aA84590fFe6FE0f6b60Eb03407D574951845B74',
    undefined,
    SPOKES_PINNED_AT,
  ),
  sodax(
    146,
    'sodax-intents',
    'SODAX Intents',
    '0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef',
    'Holds swap inputs until a solver fills them',
    '0x6695855f185e917B593D29b49FffEca02df6b512',
  ),
  sodax(
    146,
    'sodax-wallet-factory',
    'SODAX hub wallet factory',
    '0xA0ed3047D358648F2C0583B415CffCA571FDB544',
    "Creates each Safe's wallet on the hub",
    '0x0b45be992010f95d428C03Cc67751827ed65Cf9A',
  ),
  sodax(
    146,
    'sodax-wallet-router',
    'SODAX Sonic wallet router',
    '0xC67C3e55c665E78b25dc9829B3Aa5af47d914733',
    'Routes Sonic calls into the hub wallet',
    '0x6325CDcBfa700Ce5Bf662e273a65a54AD1D435fa',
  ),
  sodax(
    146,
    'sodax-hub-asset-manager',
    'SODAX hub AssetManager',
    '0x60c5681bD1DB4e50735c4cA3386005A4BA4937C0',
    'Maps spoke tokens to hub assets, sends tokens back to spokes',
    '0xe2Cac39dC98b690e96AA0926eD48DbC8933b427B',
  ),
  sodax(
    146,
    'sodax-lending-pool',
    'SODAX lending pool',
    '0x553434896D39F867761859D0FE7189d2Af70514E',
    'Money market: holds all supplied funds',
    '0x83D7b2F35b1993C49C0a4Ee99A0e472228E82560',
    SODAX_LENDING_ADDRESSES_PROVIDER,
  ),
  sodax(
    146,
    'sodax-vault-usdc',
    'SODAX vault sodaUSDC',
    '0xAbbb91c0617090F0028BDC27597Cd0D038F3A833',
    'Wraps USDC from every chain before it enters the pool',
    '0xBA5208C1EE558c8e150Bf9A0CF6CC4b43Cdbbee8',
  ),
  sodax(
    146,
    'sodax-vault-pol',
    'SODAX vault sodaPOL',
    '0x208ED38f4783328aA9eBFeC360D32e7520A9B779',
    'Wraps POL before it enters the pool',
    '0xBA5208C1EE558c8e150Bf9A0CF6CC4b43Cdbbee8',
  ),
  sodax(
    146,
    'sodax-vault-s',
    'SODAX vault sodaS',
    '0x62ecc3Eeb80a162c57624B3fF80313FE69f5203e',
    'Wraps S before it enters the pool',
    '0xBA5208C1EE558c8e150Bf9A0CF6CC4b43Cdbbee8',
  ),
]

const SODAX_AUDITS_BASE = 'https://github.com/gosodax/sodax-sdks/tree/main/Audits'

export const AUDITS: Record<ContractGroup, AuditReport[]> = {
  safe: [
    {
      title: 'Safe smart account audits',
      scope: 'Safe 1.4.x singleton, factory and libraries; all reports by version',
      url: 'https://github.com/safe-global/safe-smart-account/tree/main/docs',
    },
  ],
  sodax: [
    {
      title: 'Collaborative audit',
      scope: 'Cross-cutting review of the SODAX system',
      date: '2025-08-01',
      url: `${SODAX_AUDITS_BASE}/2025.08.01%20-%20Final%20-%20Sodax%20Collaborative%20Audit%20Report%201754078902%20(1)%20(1).pdf`,
    },
    {
      title: 'Relay audit',
      scope: 'Intent relay infrastructure',
      date: '2025-11-12',
      url: `${SODAX_AUDITS_BASE}/2025_11_12_Final_Sodax_Relay_Audit_Report_1762953394%20(1).pdf`,
    },
    {
      title: 'Collaborative audit',
      scope: 'Listed by SODAX as Stacks coverage',
      date: '2026-02-26',
      url: `${SODAX_AUDITS_BASE}/2026.02.26%20-%20Final%20-%20Sodax%20Collaborative%20Audit%20Report%201772065303.pdf`,
    },
    {
      title: 'Collaborative audit (Sherlock)',
      scope: 'LST and leverage yield vaults',
      date: '2026-05-29',
      url: `${SODAX_AUDITS_BASE}/2026.05.29%20-%20Final%20-%20Sodax%20Collaborative%20Audit%20Report%20Sherlock.pdf`,
    },
    {
      title: 'All SODAX reports',
      scope: 'Sui, Solana, Soroban, Near and the reports above',
      url: 'https://docs.sodax.com/developers/audits',
    },
  ],
}

const readOrNull = async <T>(task: Promise<T>) => {
  try {
    return await task
  } catch {
    return null
  }
}

const classify = async (client: PublicClient, address: Address) => {
  const code = await client.getCode({ address })
  if (!code || code === '0x') return { controllerKind: 'eoa' as const }
  const [threshold, owners, delay] = await Promise.all([
    readOrNull(client.readContract({ address, abi: inspectAbi, functionName: 'getThreshold' })),
    readOrNull(client.readContract({ address, abi: inspectAbi, functionName: 'getOwners' })),
    readOrNull(client.readContract({ address, abi: inspectAbi, functionName: 'getMinDelay' })),
  ])
  if (threshold !== null && owners)
    return { controllerKind: 'safe' as const, controllerThreshold: Number(threshold), controllerOwners: owners.length }
  if (delay !== null) return { controllerKind: 'timelock' as const, timelockDelaySeconds: Number(delay) }
  return { controllerKind: 'contract' as const }
}

export const inspectContract = async (client: PublicClient, contract: TrustedContract): Promise<ContractInspection> => {
  const slot = await client.getStorageAt({ address: contract.address, slot: IMPLEMENTATION_SLOT })
  const implementation = slot && BigInt(slot) !== 0n ? getAddress(slice(slot, 12)) : null
  if (!implementation) {
    const code = await client.getCode({ address: contract.address })
    const controllerKind = code && code !== '0x' ? 'immutable' : 'missing'
    return { implementation: null, controller: null, controllerKind, changedSincePin: !!contract.pinnedImplementation }
  }
  const controller = await readOrNull(
    client.readContract({ address: contract.upgradeOwnerSource ?? contract.address, abi: inspectAbi, functionName: 'owner' }),
  )
  const changedSincePin =
    !!contract.pinnedImplementation && implementation.toLowerCase() !== contract.pinnedImplementation.toLowerCase()
  if (!controller) return { implementation, controller: null, controllerKind: 'contract', changedSincePin }
  return { implementation, controller, ...(await classify(client, controller)), changedSincePin }
}
