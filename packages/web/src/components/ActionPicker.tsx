import type { ActionPlugin } from '@msa/core'
import { Icon, type IconName } from './icons.tsx'

const ACTION_ICONS: Record<string, IconName> = {
  'native-transfer': 'send',
  'token-transfer': 'coins',
  'change-threshold': 'shieldCheck',
  'match-owners': 'users',
  'sodax-swap': 'arrowLeftRight',
  'sodax-stocks': 'trendingUp',
  'sodax-supply': 'arrowDownToLine',
  'sodax-withdraw': 'arrowUpFromLine',
}

export const ActionPicker = ({ actions, onPick }: { actions: ActionPlugin[]; onPick(actionId: string): void }) => (
  <div className="action-grid">
    {actions.map((action) => (
      <button key={action.id} className="action-card" onClick={() => onPick(action.id)}>
        <span className="action-icon">
          <Icon name={ACTION_ICONS[action.id] ?? 'zap'} />
        </span>
        <strong>{action.label}</strong>
        <span className="muted small">{action.description}</span>
      </button>
    ))}
  </div>
)
