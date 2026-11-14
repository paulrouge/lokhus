import type { ServerConfig } from './config.ts'

export const contentSecurityPolicy = (config: Pick<ServerConfig, 'allowLocalhost'>) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https://raw.githubusercontent.com",
    "font-src 'self'",
    [
      "connect-src 'self' https: wss://relay.walletconnect.org wss://relay.walletconnect.com",
      ...(config.allowLocalhost ? ['http://localhost:* http://127.0.0.1:*'] : []),
    ].join(' '),
    'frame-src https://verify.walletconnect.org https://verify.walletconnect.com',
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ')

export const securityHeaders = (config: Pick<ServerConfig, 'allowLocalhost'>, secure: boolean): Record<string, string> => ({
  'Content-Security-Policy': contentSecurityPolicy(config),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), hid=(), serial=(), bluetooth=(), usb=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  ...(secure ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
})
