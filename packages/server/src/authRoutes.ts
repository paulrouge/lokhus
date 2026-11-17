import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { HttpError, clientIp, isSecureRequest, readCookie, readObject as readJsonObject, send } from './http.ts'
import {
  RegistrationClosed,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  TooManyPasskeys,
  type AuthStore,
  type Challenge,
  type ChallengePurpose,
  type Session,
} from './auth.ts'
import type { ServerConfig } from './config.ts'
import type { RateLimiter } from './limits.ts'
import type { DocStore } from './db.ts'
import { CHALLENGE_TTL_MS } from './auth.ts'
import { MAX_RECOVERY_WALLETS, hashRecoveryAuth, type KeyKind, type LockedKey, type VaultStore } from './vault.ts'
import { recoverPersonalSigner } from './walletSignature.ts'
import { verifyAcknowledgment, type AcknowledgmentStore } from './acknowledgments.ts'
import { ACKNOWLEDGMENTS, ELIGIBILITY, isAcknowledgmentKind } from '@msa/core/acknowledgment'

export interface WebAuthn {
  generateRegistrationOptions: typeof generateRegistrationOptions
  verifyRegistrationResponse: typeof verifyRegistrationResponse
  generateAuthenticationOptions: typeof generateAuthenticationOptions
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse
}

export const simpleWebAuthn: WebAuthn = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
}

export interface AuthContext {
  auth: AuthStore
  vault: VaultStore
  acknowledgments: AcknowledgmentStore
  webauthn: WebAuthn
  config: ServerConfig
  limiter: RateLimiter
  now: () => number
  regionBlocked: boolean
  storeFor(account: string): DocStore
}

export const STEP_UP_TTL_MS = CHALLENGE_TTL_MS

export const walletRecoveryMessage = (rpId: string, challenge: string) =>
  ['Recover my Lokhus account', '', `Site: ${rpId}`, `Nonce: ${challenge}`, '', 'This signature only proves you hold this wallet. It moves no funds.'].join('\n')

const WRAPPED = /^[A-Za-z0-9_-]{16,1024}$/
const SALT = /^[A-Za-z0-9_-]{16,128}$/

const lockedKeyFrom = (body: Record<string, unknown>, kinds: KeyKind[]): LockedKey => {
  const kind = body.kind as KeyKind
  if (!kinds.includes(kind)) throw new HttpError(400, 'Unknown key kind')
  if (typeof body.wrapped !== 'string' || !WRAPPED.test(body.wrapped)) throw new HttpError(400, 'Invalid locked key')
  const salt = body.salt === undefined || body.salt === null ? null : body.salt
  if (salt !== null && (typeof salt !== 'string' || !SALT.test(salt))) throw new HttpError(400, 'Invalid salt')
  return { kind, wrapped: body.wrapped, salt }
}

export interface RelyingParty {
  rpId: string
  origin: string
}

export const relyingParty = (req: IncomingMessage, config: Pick<ServerConfig, 'hosts' | 'allowLocalhost'>): RelyingParty => {
  const header = req.headers.origin
  let url: URL
  try {
    url = new URL(header ?? '')
  } catch {
    throw new HttpError(403, 'Passkeys need a request from the Lokhus page')
  }
  const localhost = config.allowLocalhost && url.hostname === 'localhost' && url.protocol === 'http:'
  const configured = config.hosts.includes(url.hostname) && url.protocol === 'https:'
  if (url.origin !== header || !(localhost || configured)) throw new HttpError(403, 'Passkeys only work on this site over https')
  return { rpId: url.hostname, origin: url.origin }
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`

export const clearedSessionCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`

const deviceLabel = (req: IncomingMessage) => {
  const agent = req.headers['user-agent'] ?? ''
  const os = [
    ['iPhone', 'iPhone'],
    ['iPad', 'iPad'],
    ['Android', 'Android'],
    ['Mac OS', 'Mac'],
    ['Windows', 'Windows'],
    ['Linux', 'Linux'],
  ].find(([needle]) => agent.includes(needle!))?.[1]
  const browser = [
    ['Edg/', 'Edge'],
    ['Firefox/', 'Firefox'],
    ['Chrome/', 'Chrome'],
    ['Safari/', 'Safari'],
  ].find(([needle]) => agent.includes(needle!))?.[1]
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown device'
}

const name = (value: unknown, what: string) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 1 || text.length > 60) throw new HttpError(400, `${what} must be 1 to 60 characters`)
  return text
}

const startSession = async (req: IncomingMessage, context: AuthContext, accountId: string) => {
  const token = await context.auth.createSession(accountId, deviceLabel(req))
  return { 'Set-Cookie': sessionCookie(token, isSecureRequest(req, context.config.trustProxy)) }
}

export const currentSession = async (req: IncomingMessage, res: ServerResponse, auth: AuthStore, trustProxy: boolean): Promise<Session | null> => {
  const result = await auth.validateSession(readCookie(req, SESSION_COOKIE))
  if (result?.refreshed) res.setHeader('Set-Cookie', sessionCookie(readCookie(req, SESSION_COOKIE)!, isSecureRequest(req, trustProxy)))
  return result?.session ?? null
}

const consumer = (context: AuthContext, purpose: ChallengePurpose, rpId: string) => {
  const state: { challenge: Challenge | null } = { challenge: null }
  return {
    state,
    expectedChallenge: async (challenge: string) => {
      state.challenge = await context.auth.consumeChallenge(challenge, purpose, rpId)
      return state.challenge !== null
    },
  }
}

export const rateLimit = async (limiter: RateLimiter, key: string, limit: number, windowMs: number) => {
  const decision = await limiter.hit(key, { limit, windowMs })
  if (!decision.allowed) throw new HttpError(429, 'Too many requests. Wait a moment and try again.', Math.ceil(decision.retryAfterMs / 1000))
}

const credentialFrom = (body: Record<string, unknown>) => {
  const response = body.response as { id?: unknown } | undefined
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') throw new HttpError(400, 'Missing passkey response')
  return response as never
}

const requireSetupCode = async (context: AuthContext, code: unknown) => {
  if (!context.auth.needsSetupCode()) return
  const result = await context.auth.checkSetupCode(code)
  if (result === 'locked') throw new HttpError(429, 'Too many wrong setup codes. Wait a minute and open the link from the server log again.')
  if (result !== 'ok') throw new HttpError(403, 'Open the link printed in the Lokhus server log to create your passkey.')
}

const requireEligibility = (context: AuthContext, version: unknown) => {
  if (context.auth.mode === 'hosted' && version !== ELIGIBILITY.version)
    throw new HttpError(400, 'Confirm that you are not a US person and not in a restricted country.', null, 'eligibility')
}

export const isEligible = async (context: Pick<AuthContext, 'auth' | 'acknowledgments'>, accountId: string) =>
  context.auth.mode !== 'hosted' || (await context.acknowledgments.eligibility(accountId, ELIGIBILITY.version)) !== null

const publicRoutes = new Set([
  'status',
  'register/options',
  'register/verify',
  'login/options',
  'login/verify',
  'logout',
  'recover/code',
  'recover/wallets/options',
  'recover/wallets/verify',
  'recover/passkey/options',
  'recover/passkey/verify',
  'recover/passkey/assert/options',
  'recover/passkey/assert/verify',
])

const requireStepUp = (session: Session, now: number) => {
  if (now - session.stepUpAt > STEP_UP_TTL_MS) throw new HttpError(403, 'Confirm with your passkey to continue.', null, 'step_up')
}

export const handleAuth = async (req: IncomingMessage, res: ServerResponse, path: string, context: AuthContext) => {
  const { auth, vault, webauthn, config, limiter, now } = context
  const route = `${req.method} ${path}`
  const ip = clientIp(req, config.trustProxy, config.proxyHops)
  const readObject = (request: IncomingMessage) => readJsonObject(request, config.limits.authBodyBytes)
  if (route !== 'GET status') await rateLimit(limiter, `auth:${ip}`, config.limits.authPerMinute, 60_000)
  const session = await currentSession(req, res, auth, config.trustProxy)
  if (!publicRoutes.has(path) && !session) throw new HttpError(401, 'Sign in first')

  if (route === 'GET status') {
    const account = session ? await auth.account(session.accountId) : null
    return send(res, 200, {
      mode: auth.mode,
      accountExists: auth.mode === 'hosted' ? false : (await auth.accounts()).length > 0,
      registrationOpen: await auth.registrationOpen(),
      awaitingPasskey: (await auth.accountAwaitingPasskey()) !== null,
      needsSetupCode: auth.needsSetupCode(),
      signedIn: !!account,
      account: account ? { id: account.id, name: account.name } : null,
      regionBlocked: context.regionBlocked,
      needsEligibility: !!account && !(await isEligible(context, account.id)),
    })
  }

  if (route === 'POST register/options') {
    const rp = relyingParty(req, config)
    if (!(await auth.registrationOpen())) throw new HttpError(403, 'Registration is closed. Sign in with a passkey instead.')
    if (auth.mode === 'hosted') await rateLimit(limiter, `register:${ip}`, config.limits.registerPerHour, 60 * 60_000)
    const body = await readObject(req)
    requireEligibility(context, body.eligibility)
    await requireSetupCode(context, body.setupCode)
    const waiting = await auth.accountAwaitingPasskey()
    const accountName = waiting?.name ?? name(body.accountName, 'Account name')
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'Lokhus',
      rpID: rp.rpId,
      userName: accountName,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'register', rpId: rp.rpId, accountId: waiting?.id ?? null, accountName })
    return send(res, 200, options)
  }

  if (route === 'POST register/verify') {
    const rp = relyingParty(req, config)
    if (!(await auth.registrationOpen())) throw new HttpError(403, 'Registration is closed. Sign in with a passkey instead.')
    const body = await readObject(req)
    requireEligibility(context, body.eligibility)
    await requireSetupCode(context, body.setupCode)
    const { state, expectedChallenge } = consumer(context, 'register', rp.rpId)
    const verification = await webauthn
      .verifyRegistrationResponse({
        response: credentialFrom(body),
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: false,
      })
      .catch(() => null)
    if (!verification?.verified || !state.challenge) throw new HttpError(400, 'The passkey could not be verified. Try again.')
    const { credential } = verification.registrationInfo
    if (await auth.passkey(credential.id)) throw new HttpError(409, 'This passkey is already registered')
    let account
    try {
      account = await auth.registerAccount(state.challenge.accountName ?? 'Lokhus', {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        rpId: rp.rpId,
        name: deviceLabel(req),
      })
    } catch (error) {
      if (error instanceof RegistrationClosed) throw new HttpError(403, 'Registration is closed. Sign in with a passkey instead.')
      throw error
    }
    if (auth.mode === 'hosted') await context.acknowledgments.confirmEligibility(account.id, ELIGIBILITY.version, ELIGIBILITY.statement)
    return send(res, 200, { account: { id: account.id, name: account.name }, passkeyId: credential.id }, await startSession(req, context, account.id))
  }

  if (route === 'POST login/options') {
    const rp = relyingParty(req, config)
    const options = await webauthn.generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'preferred' })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'login', rpId: rp.rpId, accountId: null, accountName: null })
    return send(res, 200, options)
  }

  if (route === 'POST login/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const response = credentialFrom(body) as { id: string }
    const passkey = await auth.passkey(response.id)
    if (!passkey || passkey.rpId !== rp.rpId) throw new HttpError(401, 'This passkey is not registered here')
    const { state, expectedChallenge } = consumer(context, 'login', rp.rpId)
    const verification = await webauthn
      .verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: passkey.id, publicKey: passkey.publicKey as never, counter: passkey.counter, transports: passkey.transports as never },
        requireUserVerification: false,
      })
      .catch(() => null)
    if (!verification?.verified || !state.challenge) throw new HttpError(401, 'The passkey could not be verified. Try again.')
    await auth.usePasskey(passkey.id, verification.authenticationInfo.newCounter)
    const account = (await auth.account(passkey.accountId))!
    return send(res, 200, { account: { id: account.id, name: account.name }, passkeyId: passkey.id }, await startSession(req, context, account.id))
  }

  if (route === 'POST logout') {
    await readObject(req).catch(() => null)
    await auth.endSession(readCookie(req, SESSION_COOKIE))
    return send(res, 200, { signedIn: false }, { 'Set-Cookie': clearedSessionCookie(isSecureRequest(req, config.trustProxy)) })
  }


  if (path.startsWith('recover/')) await rateLimit(limiter, `recover:${ip}`, config.limits.recoverPerHour, 60 * 60_000)

  if (route === 'POST recover/code') {
    const body = await readObject(req)
    if (typeof body.authSecret !== 'string' || !/^[0-9a-f]{64}$/.test(body.authSecret)) throw new HttpError(400, 'Invalid recovery code')
    const found = await vault.recoveryByCode(hashRecoveryAuth(body.authSecret))
    if (!found) throw new HttpError(401, 'That recovery code does not match an account.')
    const account = (await auth.account(found.accountId))!
    return send(res, 200, { grant: await vault.createGrant(found.accountId), account: { name: account.name }, locked: found.key })
  }

  if (route === 'POST recover/wallets/options') {
    const rp = relyingParty(req, config)
    const challenge = (await webauthn.generateAuthenticationOptions({ rpID: rp.rpId })).challenge
    await auth.saveChallenge({ challenge, purpose: 'wallets', rpId: rp.rpId, accountId: null, accountName: null })
    return send(res, 200, { challenge, message: walletRecoveryMessage(rp.rpId, challenge) })
  }

  if (route === 'POST recover/wallets/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    if (typeof body.challenge !== 'string' || !Array.isArray(body.signatures) || body.signatures.length > MAX_RECOVERY_WALLETS)
      throw new HttpError(400, 'Send the challenge and up to 10 signatures')
    const challenge = await auth.consumeChallenge(body.challenge, 'wallets', rp.rpId)
    if (!challenge) throw new HttpError(401, 'This recovery request expired. Start again.')
    const message = walletRecoveryMessage(rp.rpId, challenge.challenge)
    const signers = [
      ...new Set(
        body.signatures.map((signature) => (typeof signature === 'string' ? recoverPersonalSigner(message, signature) : null)).filter((x) => x !== null),
      ),
    ] as string[]
    const matches = (await vault.walletAccounts(signers)).filter((entry) => entry.matched >= entry.threshold)
    if (matches.length === 0) throw new HttpError(401, 'Not enough of your recovery wallets signed.')
    if (matches.length > 1) throw new HttpError(409, 'These wallets recover more than one account. Use your recovery code instead.')
    const account = (await auth.account(matches[0]!.accountId))!
    return send(res, 200, { grant: await vault.createGrant(account.id), account: { name: account.name } })
  }

  if (route === 'POST recover/passkey/options') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const accountId = typeof body.grant === 'string' ? await vault.grant(body.grant) : null
    if (!accountId) throw new HttpError(401, 'This recovery has expired. Start again.')
    const account = (await auth.account(accountId))!
    const existing = await auth.passkeys(accountId)
    if (existing.length >= config.limits.passkeysPerAccount)
      throw new HttpError(409, `An account can have at most ${config.limits.passkeysPerAccount} passkeys.`)
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'Lokhus',
      rpID: rp.rpId,
      userName: account.name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing.map((passkey) => ({ id: passkey.id, transports: passkey.transports as never })),
    })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'recover', rpId: rp.rpId, accountId, accountName: null })
    return send(res, 200, options)
  }

  if (route === 'POST recover/passkey/assert/options') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const accountId = typeof body.grant === 'string' ? await vault.grant(body.grant) : null
    if (!accountId) throw new HttpError(401, 'This recovery has expired. Start again.')
    const passkeys = (await auth.passkeys(accountId)).filter((passkey) => passkey.rpId === rp.rpId)
    if (passkeys.length === 0) throw new HttpError(404, 'This account has no passkey for this site')
    const options = await webauthn.generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: 'preferred',
      allowCredentials: passkeys.map((passkey) => ({ id: passkey.id, transports: passkey.transports as never })),
    })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'recover-assert', rpId: rp.rpId, accountId, accountName: null })
    return send(res, 200, options)
  }

  if (route === 'POST recover/passkey/assert/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const response = credentialFrom(body) as { id: string }
    const grantAccount = typeof body.grant === 'string' ? await vault.grant(body.grant) : null
    if (!grantAccount) throw new HttpError(401, 'This recovery has expired. Start again.')
    const passkey = await auth.passkey(response.id)
    if (!passkey || passkey.accountId !== grantAccount || passkey.rpId !== rp.rpId) throw new HttpError(401, 'Use a passkey of the account you are recovering')
    const { state, expectedChallenge } = consumer(context, 'recover-assert', rp.rpId)
    const verification = await webauthn
      .verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: passkey.id, publicKey: passkey.publicKey as never, counter: passkey.counter, transports: passkey.transports as never },
        requireUserVerification: false,
      })
      .catch(() => null)
    if (!verification?.verified || state.challenge?.accountId !== grantAccount) throw new HttpError(401, 'The passkey could not be verified. Try again.')
    if ((await vault.consumeGrant(body.grant as string)) !== grantAccount) throw new HttpError(401, 'This recovery has expired. Start again.')
    await auth.usePasskey(passkey.id, verification.authenticationInfo.newCounter)
    const account = (await auth.account(grantAccount))!
    return send(res, 200, { account: { id: account.id, name: account.name }, passkeyId: passkey.id }, await startSession(req, context, grantAccount))
  }

  if (route === 'POST recover/passkey/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const { state, expectedChallenge } = consumer(context, 'recover', rp.rpId)
    const verification = await webauthn
      .verifyRegistrationResponse({
        response: credentialFrom(body),
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: false,
      })
      .catch(() => null)
    const accountId = typeof body.grant === 'string' ? await vault.consumeGrant(body.grant) : null
    if (!verification?.verified || !accountId || state.challenge?.accountId !== accountId)
      throw new HttpError(400, 'The passkey could not be verified. Start the recovery again.')
    const { credential } = verification.registrationInfo
    if (await auth.passkey(credential.id)) throw new HttpError(409, 'This passkey is already registered')
    await auth.addPasskey(accountId, {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      rpId: rp.rpId,
      name: deviceLabel(req),
    })
    const account = (await auth.account(accountId))!
    return send(res, 200, { account: { id: account.id, name: account.name }, passkeyId: credential.id }, await startSession(req, context, accountId))
  }

  const accountId = session!.accountId
  const active = session!

  if (route === 'POST logout-all') {
    await auth.endAllSessions(accountId)
    return send(res, 200, { signedIn: false }, { 'Set-Cookie': clearedSessionCookie(isSecureRequest(req, config.trustProxy)) })
  }

  if (route === 'PUT account') {
    const body = await readObject(req)
    await auth.renameAccount(accountId, name(body.name, 'Account name'))
    const account = (await auth.account(accountId))!
    return send(res, 200, { id: account.id, name: account.name })
  }

  if (route === 'GET passkeys') {
    return send(
      res,
      200,
      (await auth.passkeys(accountId)).map((passkey) => ({
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      })),
    )
  }

  if (route === 'POST passkeys/options') {
    requireStepUp(active, now())
    const rp = relyingParty(req, config)
    const account = (await auth.account(accountId))!
    const existing = await auth.passkeys(accountId)
    if (existing.length >= config.limits.passkeysPerAccount)
      throw new HttpError(409, `An account can have at most ${config.limits.passkeysPerAccount} passkeys. Remove one first.`)
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'Lokhus',
      rpID: rp.rpId,
      userName: account.name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'add', rpId: rp.rpId, accountId, accountName: null })
    return send(res, 200, options)
  }

  if (route === 'POST passkeys/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const { state, expectedChallenge } = consumer(context, 'add', rp.rpId)
    const verification = await webauthn
      .verifyRegistrationResponse({
        response: credentialFrom(body),
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: false,
      })
      .catch(() => null)
    if (!verification?.verified || state.challenge?.accountId !== accountId) throw new HttpError(400, 'The passkey could not be verified. Try again.')
    const { credential } = verification.registrationInfo
    if (await auth.passkey(credential.id)) throw new HttpError(409, 'This passkey is already registered')
    try {
      await auth.addPasskey(accountId, {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        rpId: rp.rpId,
        name: deviceLabel(req),
      })
    } catch (error) {
      if (error instanceof TooManyPasskeys)
        throw new HttpError(409, `An account can have at most ${config.limits.passkeysPerAccount} passkeys. Remove one first.`)
      throw error
    }
    return send(res, 200, { added: true, passkeyId: credential.id })
  }


  if (route === 'POST stepup/options') {
    const rp = relyingParty(req, config)
    const passkeys = await auth.passkeys(accountId)
    const options = await webauthn.generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: 'preferred',
      allowCredentials: passkeys.map((passkey) => ({ id: passkey.id, transports: passkey.transports as never })),
    })
    await auth.saveChallenge({ challenge: options.challenge, purpose: 'stepup', rpId: rp.rpId, accountId, accountName: null })
    return send(res, 200, options)
  }

  if (route === 'POST stepup/verify') {
    const rp = relyingParty(req, config)
    const body = await readObject(req)
    const response = credentialFrom(body) as { id: string }
    const passkey = await auth.passkey(response.id)
    if (!passkey || passkey.accountId !== accountId || passkey.rpId !== rp.rpId) throw new HttpError(401, 'Use a passkey of this account')
    const { state, expectedChallenge } = consumer(context, 'stepup', rp.rpId)
    const verification = await webauthn
      .verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: passkey.id, publicKey: passkey.publicKey as never, counter: passkey.counter, transports: passkey.transports as never },
        requireUserVerification: false,
      })
      .catch(() => null)
    if (!verification?.verified || state.challenge?.accountId !== accountId) throw new HttpError(401, 'The passkey could not be verified. Try again.')
    await auth.usePasskey(passkey.id, verification.authenticationInfo.newCounter)
    await auth.markStepUp(active.tokenHash)
    return send(res, 200, { confirmed: true, passkeyId: passkey.id })
  }

  if (route === 'GET keys') return send(res, 200, await vault.status(accountId))

  if (route === 'PUT keys/check') {
    const body = await readObject(req)
    if (typeof body.check !== 'string' || !WRAPPED.test(body.check)) throw new HttpError(400, 'Invalid key check')
    return send(res, 200, { check: await vault.setCheck(accountId, body.check) })
  }

  if (route === 'POST keys/reset') {
    requireStepUp(active, now())
    await readObject(req).catch(() => null)
    await vault.resetEncryption(accountId)
    return send(res, 200, { reset: true })
  }

  if (route === 'POST keys/migrated') {
    await readObject(req).catch(() => null)
    await vault.markMigrated(accountId)
    return send(res, 200, { migrated: true })
  }

  const keyRoute = /^(GET|PUT) keys\/passkey\/([A-Za-z0-9_-]{1,1024})$/.exec(route)
  if (keyRoute) {
    const passkeyId = keyRoute[2]!
    if (keyRoute[1] === 'GET') {
      const locked = await vault.lockedKey(accountId, passkeyId)
      return locked ? send(res, 200, locked) : send(res, 404, { error: 'This passkey has no key yet' })
    }
    const body = await readObject(req)
    const locked = lockedKeyFrom(body, ['prf', 'passphrase'])
    if (await vault.lockedKey(accountId, passkeyId)) requireStepUp(active, now())
    if ((await vault.putLockedKey(accountId, passkeyId, locked)) === 'missing') throw new HttpError(404, 'Passkey not found')
    return send(res, 200, { saved: true })
  }

  if (route === 'PUT recovery/code') {
    requireStepUp(active, now())
    const body = await readObject(req)
    if (typeof body.authSecret !== 'string' || !/^[0-9a-f]{64}$/.test(body.authSecret)) throw new HttpError(400, 'Invalid recovery code')
    const locked = lockedKeyFrom({ ...body, kind: 'recovery' }, ['recovery'])
    await vault.setRecoveryCode(accountId, hashRecoveryAuth(body.authSecret), locked)
    return send(res, 200, { saved: true })
  }

  if (route === 'PUT recovery/wallets') {
    requireStepUp(active, now())
    const body = await readObject(req)
    if (body.addresses === null) {
      await vault.setRecoveryWallets(accountId, null)
      return send(res, 200, { saved: true })
    }
    const addresses = Array.isArray(body.addresses) ? [...new Set(body.addresses.map((value) => String(value).toLowerCase()))] : []
    const threshold = Number(body.threshold)
    if (addresses.length === 0 || addresses.length > MAX_RECOVERY_WALLETS || !addresses.every((address) => /^0x[0-9a-f]{40}$/.test(address)))
      throw new HttpError(400, `Add 1 to ${MAX_RECOVERY_WALLETS} wallet addresses`)
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > addresses.length)
      throw new HttpError(400, `Choose how many of the ${addresses.length} wallets must sign (1 to ${addresses.length})`)
    await vault.setRecoveryWallets(accountId, { addresses, threshold })
    return send(res, 200, { saved: true })
  }

  const acknowledgmentRoute = /^GET acknowledgments\/([a-z]{1,32})$/.exec(route)
  if (acknowledgmentRoute) {
    const kind = acknowledgmentRoute[1]
    if (!isAcknowledgmentKind(kind)) throw new HttpError(404, 'Unknown acknowledgment')
    const { version } = ACKNOWLEDGMENTS[kind]
    if (auth.mode !== 'hosted') return send(res, 200, { kind, version, required: false, acknowledgment: null })
    return send(res, 200, { kind, version, required: true, acknowledgment: await context.acknowledgments.get(accountId, kind, version) })
  }

  if (route === 'POST acknowledgments') {
    if (auth.mode !== 'hosted') throw new HttpError(404, 'Acknowledgments are only used on hosted Lokhus')
    await rateLimit(limiter, `writes:${accountId}`, config.limits.writesPerMinute, 60_000)
    const acknowledgment = verifyAcknowledgment(await readObject(req), now())
    return send(res, 200, await context.acknowledgments.add(accountId, acknowledgment))
  }

  if (route === 'POST eligibility') {
    if (auth.mode !== 'hosted') throw new HttpError(404, 'Only used on hosted Lokhus')
    requireEligibility(context, (await readObject(req)).version)
    await context.acknowledgments.confirmEligibility(accountId, ELIGIBILITY.version, ELIGIBILITY.statement)
    return send(res, 200, { confirmed: true })
  }

  if (route === 'GET export') {
    requireStepUp(active, now())
    const account = (await auth.account(accountId))!
    return send(res, 200, {
      format: 'lokhus-backup-1',
      exportedAt: new Date(now()).toISOString(),
      account: { id: account.id, name: account.name },
      vault: await vault.exportKeys(accountId),
      acknowledgments: await context.acknowledgments.list(accountId),
      eligibility: await context.acknowledgments.listEligibility(accountId),
      docs: await context.storeFor(accountId).exportAll(),
    })
  }

  if (route === 'DELETE account') {
    requireStepUp(active, now())
    const body = await readObject(req)
    const account = (await auth.account(accountId))!
    if (body.confirmName !== account.name) throw new HttpError(400, 'Type the account name exactly to confirm')
    await auth.deleteAccount(accountId)
    return send(res, 200, { deleted: true }, { 'Set-Cookie': clearedSessionCookie(isSecureRequest(req, config.trustProxy)) })
  }

  const passkeyRoute = /^(PUT|DELETE) passkeys\/([A-Za-z0-9_-]{1,1024})$/.exec(route)
  if (passkeyRoute) {
    const id = passkeyRoute[2]!
    if (passkeyRoute[1] === 'PUT') {
      const body = await readObject(req)
      if (!(await auth.renamePasskey(accountId, id, name(body.name, 'Passkey name')))) throw new HttpError(404, 'Passkey not found')
      return send(res, 200, { renamed: true })
    }
    requireStepUp(active, now())
    const result = await auth.removePasskey(accountId, id)
    if (result === 'missing') throw new HttpError(404, 'Passkey not found')
    if (result === 'last') throw new HttpError(409, 'Add another passkey before removing your last one')
    return send(res, 204)
  }

  throw new HttpError(404, 'Unknown auth route')
}
