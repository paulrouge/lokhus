import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createWalletClient, decodeEventLog, encodeFunctionData, http, parseEther, parseUnits, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  DEFAULT_CHAINS,
  buildActivity,
  buildSafeTx,
  changeThreshold,
  erc20Abi,
  safeTxHash,
  scanLogs,
  transferEvent,
  createChainClient,
  execTransactionData,
  nativeTransfer,
  predictSafeAddress,
  creationSetup,
  matchOwners,
  checkCreationOn,
  creationFromTx,
  creationOwners,
  creationTx,
  findCreation,
  readSafe,
  recoverSafeTxSigner,
  safeDeploymentTx,
  sodaxSwap,
  sodaxSupply,
  sodaxWithdraw,
  fetchLendMarkets,
  readLendPositions,
  lendPositionOf,
  safeAbi,
  safeTxTypedData,
  simulateSafeTx,
  toViemChain,
  type ChainConfig,
  type DeployedSafe,
  type SafeTxData,
  type SafeTxRecord,
  type TxSignature,
} from '@msa/core'

const FORK_PORT = 18545
const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]

const forkOf = (chainId: number) => {
  const source = DEFAULT_CHAINS.find((chain) => chain.chainId === chainId)
  if (!source) throw new Error(`No default chain ${chainId}`)
  return source
}

const startAnvil = async (forkUrl: string) => {
  const anvil = spawn('anvil', ['--fork-url', forkUrl, '--port', String(FORK_PORT), '--silent'], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await fetch(`http://127.0.0.1:${FORK_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) return anvil
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  anvil.kill()
  throw new Error('anvil did not start')
}

const SHARED_SALT = String(Date.now())
const safeAddresses = new Map<number, string>()
const creationCalls = new Map<number, string>()

const run = async (chainId: number) => {
  const source = forkOf(chainId)
  const anvil = await startAnvil(source.rpcUrls[0]!)
  try {
    const chain: ChainConfig = { ...source, rpcUrls: [`http://127.0.0.1:${FORK_PORT}`] }
    const client = createChainClient(chain)
    const [funder, ownerA, ownerB, executor] = ANVIL_KEYS.map((key) => privateKeyToAccount(key))
    const wallet = (account: typeof funder) =>
      createWalletClient({ account: account!, chain: toViemChain(chain), transport: http(chain.rpcUrls[0]) })
    const send = async (account: typeof funder, to: Hex, data: Hex, value = 0n) => {
      const hash = await wallet(account).sendTransaction({ to, data, value })
      const receipt = await client.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success', `tx ${hash} reverted`)
      return receipt
    }

    const deployBlock = await client.getBlockNumber()
    const setup = { owners: [ownerA!.address, ownerB!.address, executor!.address], threshold: 2, saltNonce: SHARED_SALT }
    const predicted = await predictSafeAddress(chain, setup)
    const deployment = await safeDeploymentTx(chain, setup)
    const deployReceipt = await send(funder, deployment.to, deployment.data, BigInt(deployment.value))
    const onchain = await readSafe(client, predicted)
    assert.deepEqual(onchain.owners.map((owner) => owner.toLowerCase()).sort(), setup.owners.map((owner) => owner.toLowerCase()).sort())
    assert.equal(onchain.threshold, 2)
    console.log(`  deployed ${predicted} (Safe ${onchain.version}, 2 of 3)`)
    safeAddresses.set(chainId, predicted)

    await send(funder, predicted, '0x', parseEther('1'))
    const safe: DeployedSafe = {
      id: 'e2e',
      name: 'e2e',
      chainId,
      status: 'deployed',
      address: predicted,
      owners: setup.owners,
      threshold: 2,
      saltNonce: setup.saltNonce,
      createdAt: '',
    }
    assert.deepEqual(await creationSetup(chain, safe), setup)
    assert.equal(await creationSetup(chain, { ...safe, owners: [ownerA!.address, ownerB!.address] }), null)
    assert.equal(await creationSetup(chain, { ...safe, owners: [...setup.owners].reverse() }), null)
    console.log('  creation setup verified against the address ✓')
    const fromTx = await findCreation(client, predicted, { txHash: deployReceipt.transactionHash })
    const fromBlock = await findCreation(client, predicted, { block: deployReceipt.blockNumber })
    assert.deepEqual(fromTx, { ...creationFromTx(deployment), txHash: deployReceipt.transactionHash })
    assert.deepEqual(fromBlock, fromTx)
    assert.deepEqual(creationOwners(fromTx), { owners: setup.owners, threshold: 2 })
    await checkCreationOn(client, chainId, fromTx, predicted)
    assert.deepEqual(creationTx(fromTx), { to: deployment.to, value: '0', data: deployment.data })
    creationCalls.set(chainId, creationTx(fromTx).data)
    console.log('  creation read back from the chain and replayable ✓')
    const recipient = privateKeyToAccount(generatePrivateKey()).address
    const first = await nativeTransfer.build({ to: recipient, amount: '0.1' }, { chain, safe, client })
    const second = await nativeTransfer.build({ to: recipient, amount: '0.15' }, { chain, safe, client })
    const tx = buildSafeTx([...first.calls, ...second.calls], onchain.nonce, chainId)
    assert.equal(tx.operation, 1)

    const asRecord = (safeTx: SafeTxData): SafeTxRecord => ({
      id: safeTxHash(safeTx, predicted, chainId),
      safeId: safe.id,
      chainId,
      safeAddress: predicted,
      tx: safeTx,
      action: { pluginId: 'e2e', input: {}, summary: 'e2e', calls: [] },
      signatures: [],
      status: 'pending',
      createdAt: '',
    })
    const simulated = await simulateSafeTx(client, asRecord(tx), chain)
    assert.equal(simulated.mode, 'full')
    assert.ok(simulated.success, `simulation reverted: ${simulated.revertReason}`)
    assert.deepEqual(simulated.setupChanges, [])
    const deltaOf = (address: string) =>
      simulated.deltas.find((delta) => delta.address.toLowerCase() === address.toLowerCase())?.changes.find((change) => change.token === 'native')?.amount
    assert.equal(deltaOf(predicted), -parseEther('0.25'))
    assert.equal(deltaOf(recipient), parseEther('0.25'))
    const queued = await simulateSafeTx(
      client,
      asRecord(buildSafeTx((await changeThreshold.build({ threshold: '3' }, { chain, safe, client })).calls, onchain.nonce + 1n, chainId)),
      chain,
    )
    assert.ok(queued.success && queued.nonceOverridden, `queued simulation: ${queued.revertReason}`)
    assert.deepEqual(queued.setupChanges, ['Changes the threshold from 2 to 3'])
    console.log('  simulation: batch shows -0.25 from the Safe to the recipient, queued threshold change detected ✓')

    const signatures: TxSignature[] = []
    for (const owner of [ownerB!, ownerA!]) {
      const data = await owner.signTypedData(safeTxTypedData(tx, predicted, chainId))
      const signer = await recoverSafeTxSigner(tx, predicted, chainId, data)
      assert.equal(signer, owner.address)
      signatures.push({ signer, data, signedAt: '' })
    }

    const before = await client.getBalance({ address: recipient })
    await send(executor, predicted, execTransactionData(tx, signatures))
    const after = await client.getBalance({ address: recipient })
    assert.equal(after - before, parseEther('0.25'))
    assert.equal((await readSafe(client, predicted)).nonce, onchain.nonce + 1n)
    console.log('  batched 2 transfers, signed by 2 owners, executed by a third wallet ✓')

    const raise = await changeThreshold.build({ threshold: '3' }, { chain, safe, client })
    const thresholdTx = buildSafeTx(raise.calls, onchain.nonce + 1n, chainId)
    assert.equal(thresholdTx.operation, 0)
    const thresholdSignatures: TxSignature[] = []
    for (const owner of [ownerA!, ownerB!]) {
      const data = await owner.signTypedData(safeTxTypedData(thresholdTx, predicted, chainId))
      thresholdSignatures.push({ signer: await recoverSafeTxSigner(thresholdTx, predicted, chainId, data), data, signedAt: '' })
    }
    await send(executor, predicted, execTransactionData(thresholdTx, thresholdSignatures))
    assert.equal((await readSafe(client, predicted)).threshold, 3)
    await assert.rejects(changeThreshold.build({ threshold: '4' }, { chain, safe, client }))
    console.log(`  ${raise.summary} ✓`)

    const usdc = chain.tokens.find((token) => token.symbol === 'USDC')!
    const eurc = chain.tokens.find((token) => token.symbol === 'EURC')
    await send(funder, usdc.address, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [predicted, 0n] }))
    const deal = async (token: { address: Hex; decimals: number }, amount: string) => {
      const recent = await client.getLogs({
        address: token.address,
        event: transferEvent[0],
        fromBlock: (await client.getBlockNumber({ cacheTime: 0 })) - 20n,
      })
      for (const candidate of new Set(recent.map((log) => log.args.to).filter((to): to is Hex => !!to))) {
        const [balance, code] = await Promise.all([
          client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [candidate] }),
          client.getCode({ address: candidate }),
        ])
        if (balance < parseUnits(amount, token.decimals) || (code && code !== '0x')) continue
        await client.request({ method: 'anvil_impersonateAccount', params: [candidate] } as never)
        await client.request({ method: 'anvil_setBalance', params: [candidate, toHex(parseEther('1000'))] } as never)
        const hash = await createWalletClient({ account: candidate, chain: toViemChain(chain), transport: http(chain.rpcUrls[0]) }).sendTransaction({
          to: token.address,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [predicted, parseUnits(amount, token.decimals)] }),
        })
        assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
        return true
      }
      return false
    }
    const dealt = await deal(usdc, '10')
    const eurcDealt = !!eurc && (await deal(eurc, '10'))

    const logs = await scanLogs(client, predicted, chain.tokens.map((token) => token.address), deployBlock, await client.getBlockNumber({ cacheTime: 0 }))
    const activity = await buildActivity(client, chain, safe, logs)
    const executed = activity.find((item) => item.kind === 'executed' && item.safeTxHash === safeTxHash(tx, predicted, chainId))
    assert.equal(executed?.summary, 'Batch of 2 calls')
    assert.ok(activity.some((item) => item.kind === 'executed' && item.summary === 'Changed threshold to 3'))
    assert.ok(activity.some((item) => item.kind === 'threshold-changed' && item.summary === 'Threshold set to 3'))
    assert.ok(activity.some((item) => item.kind === 'received' && item.summary.startsWith('Received 1 ')))
    const zero = activity.find((item) => item.kind === 'token-received' && item.amountRaw === '0')
    assert.equal(zero?.hidden, 'zero-value')
    if (dealt) {
      const deposit = activity.find((item) => item.kind === 'token-received' && item.amountRaw !== '0' && item.summary.includes('USDC'))
      assert.equal(deposit?.hidden, undefined)
      assert.match(deposit!.summary, /^Received 10 USDC/)
    }
    console.log(`  activity: ${activity.length} items, executed tx matched by hash, zero-value spam hidden${dealt ? ', USDC deposit shown' : ' (no USDC holder found, skipped)'} ✓`)

    await client.request({ method: 'anvil_setBalance', params: [predicted, toHex(parseEther('100'))] } as never)
    const hubChain = forkOf(146)
    const hubClient = chainId === 146 ? client : createChainClient(hubChain)
    const swap = sodaxSwap(() => hubClient)
    const native = '0x0000000000000000000000000000000000000000'
    const symbolOf = (address: Hex) => (address === native ? chain.nativeSymbol : chain.tokens.find((token) => token.address === address)!.symbol)
    const swaps: [Hex, Hex, string][] = [
      [native, usdc.address, chain.nativeSymbol === 'ETH' ? '0.02' : '50'],
      ...(dealt ? [[usdc.address, native, '5'] as [Hex, Hex, string]] : []),
      ...(eurcDealt ? [[eurc!.address, usdc.address, '5'] as [Hex, Hex, string]] : []),
    ]
    for (const [sell, buy, amount] of swaps) {
      const pair = `${symbolOf(sell)}>${symbolOf(buy)}`
      const built = await swap.build({ sell, buy, amount, slippage: '1', minutes: '5' }, { chain, safe, client }).catch((error: Error) => error)
      if (built instanceof Error) {
        console.log(`  SODAX ${pair}: skipped, ${built.message}`)
        continue
      }
      const current = await readSafe(client, predicted)
      const swapTx = buildSafeTx(built.calls, current.nonce, chainId)
      const swapSignatures: TxSignature[] = []
      for (const owner of [ownerA!, ownerB!, executor!]) {
        const data = await owner.signTypedData(safeTxTypedData(swapTx, predicted, chainId))
        swapSignatures.push({ signer: await recoverSafeTxSigner(swapTx, predicted, chainId, data), data, signedAt: '' })
      }
      const receipt = await send(executor, predicted, execTransactionData(swapTx, swapSignatures))
      const success = receipt.logs.some((log) => {
        try {
          return log.address.toLowerCase() === predicted.toLowerCase() && decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics }).eventName === 'ExecutionSuccess'
        } catch {
          return false
        }
      })
      assert.ok(success, `SODAX ${pair} inner call failed`)
      console.log(`  SODAX ${pair}: ${built.summary}, executed by the Safe ✓`)
    }

    const executeBuilt = async (calls: Parameters<typeof buildSafeTx>[0]) => {
      const current = await readSafe(client, predicted)
      const safeTx = buildSafeTx(calls, current.nonce, chainId)
      const sigs: TxSignature[] = []
      for (const owner of [ownerA!, ownerB!, executor!]) {
        const data = await owner.signTypedData(safeTxTypedData(safeTx, predicted, chainId))
        sigs.push({ signer: await recoverSafeTxSigner(safeTx, predicted, chainId, data), data, signedAt: '' })
      }
      const receipt = await send(executor, predicted, execTransactionData(safeTx, sigs))
      return receipt.logs.some((log) => {
        try {
          return log.address.toLowerCase() === predicted.toLowerCase() && decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics }).eventName === 'ExecutionSuccess'
        } catch {
          return false
        }
      })
    }

    const markets = await fetchLendMarkets(chainId)
    const supply = sodaxSupply(() => hubClient)
    const withdraw = sodaxWithdraw(() => hubClient)
    const lendTokens = [native, ...(dealt ? [usdc.address] : [])]
    for (const token of lendTokens) {
      const market = markets.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase())
      if (!market) {
        console.log(`  SODAX supply ${token}: not a money market token here, skipped`)
        continue
      }
      const amount = token === native ? (chain.nativeSymbol === 'ETH' ? '0.02' : '20') : '2'
      const positionBefore = lendPositionOf(market, await readLendPositions(chainId, predicted, hubClient, [market]))
      const built = await supply.build({ token, amount }, { chain, safe, client })
      assert.ok(await executeBuilt(built.calls), `SODAX supply ${market.symbol} inner call failed`)
      if (chainId !== 146) {
        console.log(`  SODAX ${built.summary}: executed by the Safe, hub leg needs the live relay ✓`)
        await assert.rejects(withdraw.build({ token, amount }, { chain, safe, client }), /only 0/)
        continue
      }
      const positionAfter = lendPositionOf(market, await readLendPositions(chainId, predicted, hubClient, [market]))
      const supplied = parseUnits(amount, market.decimals)
      assert.ok(positionAfter - positionBefore >= supplied - 1n, `position grew by ${positionAfter - positionBefore}, expected ${supplied}`)
      console.log(`  SODAX ${built.summary}: position ${positionBefore} → ${positionAfter} ✓`)

      const half = token === native ? '10' : '1'
      const balanceOf = () =>
        token === native
          ? client.getBalance({ address: predicted })
          : client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [predicted] })
      const balanceBefore = await balanceOf()
      const out = await withdraw.build({ token, amount: half }, { chain, safe, client })
      assert.ok(await executeBuilt(out.calls), `SODAX withdraw ${market.symbol} inner call failed`)
      assert.equal((await balanceOf()) - balanceBefore, parseUnits(half, market.decimals))
      console.log(`  SODAX ${out.summary}: tokens back in the Safe ✓`)
      await assert.rejects(withdraw.build({ token, amount: '1000000' }, { chain, safe, client }), /is supplied/)
    }

    const ownersBefore = await readSafe(client, predicted)
    const target = {
      owners: [ownerA!.address, privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address],
      threshold: 2,
    }
    const sync = await matchOwners.build({ owners: target.owners.join(', '), threshold: '2' }, { chain, safe, client })
    assert.ok(await executeBuilt(sync.calls), 'owner sync inner call failed')
    const ownersAfter = await readSafe(client, predicted)
    assert.deepEqual(ownersAfter.owners.map((owner) => owner.toLowerCase()).sort(), target.owners.map((owner) => owner.toLowerCase()).sort())
    assert.equal(ownersAfter.threshold, 2)
    await assert.rejects(matchOwners.build({ owners: target.owners.join(','), threshold: '2' }, { chain, safe, client }), /already match/)
    console.log(`  ${sync.summary} (from ${ownersBefore.threshold} of ${ownersBefore.owners.length}) ✓`)
  } finally {
    anvil.kill()
  }
}

const E2E_CHAINS = (process.env.E2E_CHAINS ?? '137,146,8453,1').split(',').map(Number)
for (const chainId of E2E_CHAINS) {
  console.log(`Fork e2e on ${forkOf(chainId).name}`)
  await run(chainId)
}
assert.equal(new Set(safeAddresses.values()).size, 1, `same setup gave different addresses: ${[...safeAddresses.entries()].join(' ')}`)
assert.equal(new Set(creationCalls.values()).size, 1, 'creation calls differ between chains')
console.log(`Same Safe address on every chain: ${[...safeAddresses.values()][0]} ✓`)
console.log('All fork checks passed')
