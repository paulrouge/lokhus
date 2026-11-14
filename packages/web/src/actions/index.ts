import type { ComponentType } from 'react'
import type { ActionContext } from '@msa/core'
import { SodaxStocksForm, SodaxSwapForm } from './SodaxSwapForm.tsx'
import { SodaxSupplyForm, SodaxWithdrawForm } from './SodaxLendForm.tsx'

export interface ActionFormProps {
  input: Record<string, string>
  onChange(next: Record<string, string>): void
  context: ActionContext
}

export const actionForms: Record<string, ComponentType<ActionFormProps>> = {
  'sodax-swap': SodaxSwapForm,
  'sodax-stocks': SodaxStocksForm,
  'sodax-supply': SodaxSupplyForm,
  'sodax-withdraw': SodaxWithdrawForm,
}
