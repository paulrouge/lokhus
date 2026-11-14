import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import type { ComponentType } from 'react'
import { PublicShell } from './components/PublicShell.tsx'
import { Welcome } from './pages/Welcome.tsx'
import { Trust } from './pages/Trust.tsx'
import { PublicSecurity } from './pages/Security.tsx'
import { BestPractice } from './pages/BestPractice.tsx'

export { PUBLIC_META, SITE_URL } from './seo.ts'

const inShell = (Page: ComponentType) => () => (
  <PublicShell>
    <main className="landing-page">
      <Page />
    </main>
  </PublicShell>
)

const PAGES: Record<string, ComponentType> = {
  '/welcome': Welcome,
  '/trust': Trust,
  '/security': inShell(PublicSecurity),
  '/best-practice': inShell(BestPractice),
}

export const render = (path: string) => {
  const Page = PAGES[path]
  if (!Page) throw new Error(`No prerender for ${path}`)
  return renderToString(
    <StaticRouter location={path}>
      <Page />
    </StaticRouter>,
  )
}
