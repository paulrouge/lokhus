import type { CollectionName, Filter, PageQuery, Storage } from '@msa/core'

export class StorageError extends Error {
  readonly status: number
  readonly retryAfterSeconds: number | null

  constructor(message: string, status: number, retryAfterSeconds: number | null) {
    super(message)
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const request = async (url: string, init: RequestInit | undefined, onSignedOut: () => void) => {
  const response = await fetch(url, {
    ...init,
    headers: { 'X-MSA': '1', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (response.status === 401 || response.status === 403 || response.status === 451) onSignedOut()
  if (response.status === 401) throw new Error('Signed out')
  if (response.status === 404 && (!init?.method || init.method === 'GET')) return null
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new StorageError(body?.error ?? `Storage request failed (${response.status})`, response.status, Number(response.headers.get('Retry-After')) || null)
  }
  return response.status === 204 ? null : response.json()
}

const collectionUrl = (base: string, collection: CollectionName, id?: string) =>
  `${base}/${collection}${id ? `/${encodeURIComponent(id)}` : ''}`

export type HttpStorage = Storage & { removePlaintext(collection: CollectionName): Promise<number> }

export const createHttpStorage = (base = '/api', onSignedOut: () => void = () => {}): HttpStorage => ({
  removePlaintext: async (collection) =>
    ((await request(`${collectionUrl(base, collection)}?_plaintext=1`, { method: 'DELETE' }, onSignedOut)) as { removed: number }).removed,
  list: async (collection, filter?: Filter) => {
    const query = filter ? `?${new URLSearchParams(Object.entries(filter).map(([k, v]) => [k, String(v)]))}` : ''
    return (await request(`${collectionUrl(base, collection)}${query}`, undefined, onSignedOut)) ?? []
  },
  page: async (collection, query: PageQuery) => {
    const params = new URLSearchParams(Object.entries(query.filter ?? {}).map(([k, v]) => [k, String(v)]))
    params.set('_order', query.order.map(({ field, numeric }) => (numeric ? `${field}:n` : field)).join(','))
    params.set('_dir', query.direction)
    params.set('_limit', String(query.limit))
    if (query.cursor) params.set('_cursor', query.cursor)
    return (await request(`${collectionUrl(base, collection)}?${params}`, undefined, onSignedOut)) ?? { items: [], nextCursor: null }
  },
  get: (collection, id) => request(collectionUrl(base, collection, id), undefined, onSignedOut),
  put: (collection, item) => request(collectionUrl(base, collection, item.id), { method: 'PUT', body: JSON.stringify(item) }, onSignedOut),
  remove: async (collection, id) => {
    await request(collectionUrl(base, collection, id), { method: 'DELETE' }, onSignedOut)
  },
})
