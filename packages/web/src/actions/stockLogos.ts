const STOCK_LOGOS = new Set([
  'aapl', 'amc', 'amd', 'amzn', 'baba', 'bull', 'coin', 'cost', 'gld', 'gme', 'googl', 'hims', 'ibm', 'intc', 'jnj', 'lly',
  'lulu', 'meta', 'mrna', 'msft', 'mstr', 'mu', 'net', 'nflx', 'nvda', 'pltr', 'qqq', 'qubt', 'rblx', 'rddt', 'rivn', 'sgov',
  'slv', 'snap', 'sndk', 'spy', 'tsla', 'tsm', 'ttwo', 'ups', 'uso',
])

export const stockLogo = (symbol: string) => (STOCK_LOGOS.has(symbol.toLowerCase()) ? `/stocks/${symbol.toLowerCase()}.png` : undefined)
