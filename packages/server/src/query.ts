import { FIELD_NAME, type Filter, type PageQuery } from '@msa/core/storage'
import { InvalidPageQuery } from './db.ts'

const PAGE_PARAMS = new Set(['_limit', '_order', '_dir', '_cursor'])

export type ListQuery = { kind: 'list'; filter: Filter } | { kind: 'page'; query: PageQuery }

export const parseListQuery = (params: URLSearchParams): ListQuery => {
  const filter: Filter = {}
  for (const [key, value] of params) {
    if (key.startsWith('_')) {
      if (!PAGE_PARAMS.has(key)) throw new InvalidPageQuery(`Unknown parameter: ${key}`)
      continue
    }
    if (!FIELD_NAME.test(key)) throw new InvalidPageQuery('Invalid filter field')
    filter[key] = value
  }
  const limit = params.get('_limit')
  const order = params.get('_order')
  if (limit === null && order === null && !params.has('_cursor') && !params.has('_dir')) return { kind: 'list', filter }
  if (!order) throw new InvalidPageQuery('Paging needs _order')
  if (limit === null || !/^\d{1,4}$/.test(limit)) throw new InvalidPageQuery('Paging needs a numeric _limit')
  const dir = params.get('_dir') ?? 'asc'
  if (dir !== 'asc' && dir !== 'desc') throw new InvalidPageQuery('_dir must be asc or desc')
  const fields = order.split(',').map((part) => {
    const [field = '', type] = part.split(':')
    if (!FIELD_NAME.test(field) || (type !== undefined && type !== 'n')) throw new InvalidPageQuery(`Invalid order: ${part}`)
    return { field, numeric: type === 'n' }
  })
  return {
    kind: 'page',
    query: { filter, order: fields, direction: dir, limit: Number(limit), cursor: params.get('_cursor') ?? undefined },
  }
}
