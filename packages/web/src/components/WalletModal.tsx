import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useWallet } from '../state/wallet.tsx'
import { Avatar, Button, CopyButton, ErrorNote, Modal } from './ui.tsx'
import { shortAddress } from '../lib/format.ts'

const QrPanel = ({ uri }: { uri: string }) => {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    void QRCode.toString(uri, { type: 'svg', margin: 1, color: { dark: '#16181d', light: '#ffffff' } }).then(setSvg)
  }, [uri])
  return (
    <div className="qr-panel">
      <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="muted">Scan with Tangem, MetaMask mobile or any WalletConnect wallet.</p>
      <div className="row gap-sm center">
        <span className="muted small">Copy link</span>
        <CopyButton value={uri} />
      </div>
    </div>
  )
}

export const WalletModal = () => {
  const { modalOpen, closeConnect, plugins, connect, connectingId, qrUri, pick, error } = useWallet()

  return (
    <Modal open={modalOpen} title={pick ? (pick.title ?? 'Choose an account') : qrUri ? 'Scan to connect' : 'Connect a signer'} onClose={closeConnect}>
      {pick ? (
        <div className="stack gap-sm">
          {pick.choices.map((choice, index) => (
            <button key={choice.address} className="list-option" onClick={() => pick.resolve(index)}>
              <Avatar address={choice.address} />
              <span className="grow">
                <strong>{choice.label}</strong>
                <span className="mono muted small block">{shortAddress(choice.address)}</span>
              </span>
              <span className="muted">→</span>
            </button>
          ))}
          {pick.newLabel && (
            <button className="list-option" onClick={() => pick.resolve(pick.choices.length)}>
              <span className="grow">
                <strong>{pick.newLabel}</strong>
              </span>
              <span className="muted">→</span>
            </button>
          )}
        </div>
      ) : qrUri ? (
        <QrPanel uri={qrUri} />
      ) : (
        <div className="stack gap-sm">
          {plugins.map((plugin) => {
            const available = plugin.isAvailable()
            return (
              <button
                key={plugin.id}
                className="list-option"
                disabled={!available || !!connectingId}
                onClick={() => void connect(plugin)}
              >
                {plugin.icon ? <img className="wallet-icon" src={plugin.icon} alt="" /> : <span className="wallet-icon" />}
                <span className="grow">
                  <strong>{plugin.label}</strong>
                  <span className="muted small block">{plugin.description}</span>
                </span>
                {connectingId === plugin.id ? <span className="spinner" /> : <span className="muted">→</span>}
              </button>
            )
          })}
          {plugins.length === 0 && <p className="muted">No wallets found.</p>}
        </div>
      )}
      <ErrorNote error={error} />
      {(qrUri || pick) && (
        <div className="modal-foot">
          <Button variant="ghost" onClick={closeConnect}>
            Cancel
          </Button>
        </div>
      )}
    </Modal>
  )
}
