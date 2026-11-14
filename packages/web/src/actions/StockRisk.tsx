export const StockRisk = () => (
  <details className="explain">
    <summary>What you are buying, and the risks</summary>
    <p>
      A SODAX token on Sonic that tracks a US share or ETF. Each one is meant to be backed 1:1 by a Robinhood stock token that SODAX
      holds on Robinhood Chain. These are Robinhood's onchain tokens, not the stocks in the Robinhood app.
    </p>
    <p>
      <strong>Robinhood's token</strong> is a debt security issued by Robinhood Assets (Jersey) Limited. It gives you the share's price,
      not the share: no voting, no claim on the company. If the issuer fails you can lose some or all of it.
    </p>
    <p>
      <strong>SODAX's copy</strong> is only worth something while its backing and the link between the chains hold. A contract bug or a
      broken link can make it drift from the share price. It cannot be redeemed for Robinhood's token yet, so you exit by selling, and
      outside US market hours there are fewer buyers.
    </p>
    <p>
      Lokhus is an independent project, not made or endorsed by SODAX or Robinhood. It only uses their public contracts and APIs to
      build the trade, which your own keys sign.
    </p>
    <p>
      Nobody checks who you are. You alone are responsible for making sure you may hold these tokens where you live. They may not be
      offered to US persons, and sales are restricted in several other countries.
    </p>
    <p>
      <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">
        Robinhood: how stock tokens work
      </a>
      {' · '}
      <a href="https://docs.robinhood.com/rhj" target="_blank" rel="noreferrer">
        Prospectus and restricted countries
      </a>
    </p>
  </details>
)
