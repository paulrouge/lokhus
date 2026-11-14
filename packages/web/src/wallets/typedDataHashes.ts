import { getTypesForEIP712Domain, hashDomain, hashStruct, type Hex, type TypedDataDomain } from 'viem'

type TypedField = { name: string; type: string }
type TypedTypes = Record<string, TypedField[]>

export interface TypedDataJson {
  domain: TypedDataDomain
  types: TypedTypes
  primaryType: string
  message: Record<string, unknown>
}

const reviveValue = (type: string, value: unknown, types: TypedTypes): unknown => {
  if (type.endsWith(']')) {
    const inner = type.slice(0, type.lastIndexOf('['))
    return (value as unknown[]).map((item) => reviveValue(inner, item, types))
  }
  if (/^u?int\d*$/.test(type)) return BigInt(value as string | number)
  const struct = types[type]
  if (struct) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(struct.map((field) => [field.name, reviveValue(field.type, record[field.name], types)]))
  }
  return value
}

export const parseTypedData = (raw: unknown): TypedDataJson => {
  const typed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataJson
  return {
    ...typed,
    types: { ...typed.types, EIP712Domain: typed.types.EIP712Domain ?? getTypesForEIP712Domain({ domain: typed.domain }) },
  }
}

export const typedDataHashes = (raw: unknown): { domainHash: Hex; messageHash: Hex } => {
  const typed = parseTypedData(raw)
  const types = typed.types
  const domain = reviveValue('EIP712Domain', typed.domain, types) as TypedDataDomain
  const message = reviveValue(typed.primaryType, typed.message, types) as Record<string, unknown>
  return {
    domainHash: hashDomain({ domain, types } as never),
    messageHash: hashStruct({ data: message, primaryType: typed.primaryType, types } as never),
  }
}
