import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB = join(import.meta.dirname, '..')
const DIST = join(WEB, 'dist')
const SSR = join(WEB, 'dist-ssr')

interface PageMeta {
  title: string
  description: string
}

const { render, PUBLIC_META, SITE_URL } = (await import(pathToFileURL(join(SSR, 'prerender.js')).href)) as {
  render: (path: string) => string
  PUBLIC_META: Record<string, PageMeta>
  SITE_URL: string
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const setContent = (html: string, attribute: string, content: string) => {
  const pattern = new RegExp(`(<meta ${attribute} content=")[^"]*(")`)
  if (!pattern.test(html)) throw new Error(`index.html has no <meta ${attribute}>`)
  return html.replace(pattern, `$1${escape(content)}$2`)
}

const template = await readFile(join(DIST, 'index.html'), 'utf8')
await mkdir(join(DIST, 'prerendered'), { recursive: true })

for (const [path, meta] of Object.entries(PUBLIC_META)) {
  const url = `${SITE_URL}${path}`
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${escape(meta.title)}</title>`)
  html = setContent(html, 'name="description"', meta.description)
  html = setContent(html, 'property="og:title"', meta.title)
  html = setContent(html, 'property="og:description"', meta.description)
  html = setContent(html, 'property="og:url"', url)
  html = html.replace('</head>', `  <link rel="canonical" href="${url}" />\n  </head>`)
  html = html.replace('<div id="root"></div>', `<div id="root">${render(path)}</div>`)
  await writeFile(join(DIST, 'prerendered', `${path.slice(1)}.html`), html)
}

const urls = Object.keys(PUBLIC_META).map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`)
await writeFile(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
)
await rm(SSR, { recursive: true, force: true })
