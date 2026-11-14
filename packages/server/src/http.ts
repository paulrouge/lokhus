import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  readonly retryAfterSeconds: number | null
  readonly code: string | null

  constructor(status: number, message: string, retryAfterSeconds: number | null = null, code: string | null = null) {
    super(message)
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.code = code
  }
}

export const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string | string[]> = {}) => {
  if (body === undefined) {
    res.writeHead(status, headers).end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body))
}

export const readBody = async (req: IncomingMessage, maxBytes: number): Promise<unknown> => {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON')
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new HttpError(413, tooLarge(maxBytes))
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, tooLarge(maxBytes))
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const tooLarge = (maxBytes: number) => `This is too large to save (limit ${Math.round(maxBytes / 1024)} KB)`

export const readObject = async (req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> => {
  const body = await readBody(req, maxBytes)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object')
  return body as Record<string, unknown>
}

export const readCookie = (req: IncomingMessage, name: string): string | null => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}

const forwarded = (value: string | string[] | undefined, fromRight = 1) => {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '')
  const parts = joined
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts[parts.length - fromRight] ?? null
}

const lastForwarded = (value: string | string[] | undefined) => forwarded(value)

export const clientIp = (req: IncomingMessage, trustProxy: boolean, proxyHops = 1) =>
  (trustProxy ? forwarded(req.headers['x-forwarded-for'], proxyHops) : null) ?? req.socket.remoteAddress ?? 'unknown'

export const isSecureRequest = (req: IncomingMessage, trustProxy: boolean) =>
  trustProxy ? lastForwarded(req.headers['x-forwarded-proto']) === 'https' : 'encrypted' in req.socket && req.socket.encrypted === true
