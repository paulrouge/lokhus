import './polyfills.ts'
import { StrictMode, useEffect, useMemo, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { seedDefaults } from '@msa/core'
import { createHttpStorage, type HttpStorage } from './storage/httpStorage.ts'
import { createEncryptedStorage } from './crypto/encryptedStorage.ts'
import { vaultKeys } from './lib/vault.ts'
import { VaultGate } from './components/VaultGate.tsx'
import { Recover } from './pages/Recover.tsx'
import { DataProvider, useChains, useStorage } from './state/data.tsx'
import { WalletProvider } from './state/wallet.tsx'
import { setKnownChains } from './plugins.ts'
import { Layout } from './components/Layout.tsx'
import { Home } from './pages/Home.tsx'
import { SafeSetup } from './pages/SafeSetup.tsx'
import { SafeView } from './pages/SafeView.tsx'
import { TxNew } from './pages/TxNew.tsx'
import { TxView } from './pages/TxView.tsx'
import { Owners } from './pages/Owners.tsx'
import { Notebook } from './pages/Notebook.tsx'
import { BestPractice } from './pages/BestPractice.tsx'
import { PublicSecurity, Security } from './pages/Security.tsx'
import { PublicShell } from './components/PublicShell.tsx'
import { Welcome } from './pages/Welcome.tsx'
import { Trust } from './pages/Trust.tsx'
import { SignIn } from './pages/SignIn.tsx'
import { refreshAuth, useAuth } from './lib/auth.ts'
import { Settings } from './pages/Settings.tsx'
import { usePageMeta } from './seo.ts'
import '@fontsource-variable/fraunces/full.css'
import './styles.css'

const Bootstrap = () => {
  const storage = useStorage()
  const { chains } = useChains()

  useEffect(() => {
    void seedDefaults(storage)
  }, [storage])

  useEffect(() => setKnownChains(chains), [chains])

  return null
}

const PUBLIC_PAGES: Record<string, ComponentType> = { '/security': PublicSecurity, '/best-practice': BestPractice }

const SignedIn = ({ raw }: { raw: HttpStorage }) => {
  const status = useAuth()
  const { pathname } = useLocation()
  usePageMeta(status?.signedIn ? undefined : pathname)
  if (!status) return null
  if (!status.signedIn || !status.account) {
    const PublicPage = PUBLIC_PAGES[pathname]
    if (!PublicPage) return <Navigate to="/welcome" replace />
    return (
      <PublicShell>
        <main className="landing-page">
          <PublicPage />
        </main>
      </PublicShell>
    )
  }
  return (
    <VaultGate key={status.account.id} accountId={status.account.id} raw={raw}>
    <WalletProvider>
      <Bootstrap />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/safes/new" element={<SafeSetup />} />
          <Route path="/safes/new/:id" element={<SafeSetup />} />
          <Route path="/safes/:id" element={<SafeView />} />
          <Route path="/safes/:id/new" element={<TxNew />} />
          <Route path="/safes/:id/tx/:hash" element={<TxView />} />
          <Route path="/owners" element={<Owners />} />
          <Route path="/chains" element={<Navigate to="/settings#chains" replace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/notebook" element={<Notebook />} />
          <Route path="/best-practice" element={<BestPractice />} />
          <Route path="/security" element={<Security />} />
        </Routes>
      </Layout>
    </WalletProvider>
    </VaultGate>
  )
}

const App = () => {
  const raw = useMemo(() => createHttpStorage('/api', () => void refreshAuth()), [])
  const storage = useMemo(() => createEncryptedStorage(raw, vaultKeys), [raw])
  return (
    <DataProvider storage={storage}>
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/trust" element={<Trust />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="*" element={<SignedIn raw={raw} />} />
        </Routes>
      </BrowserRouter>
    </DataProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
