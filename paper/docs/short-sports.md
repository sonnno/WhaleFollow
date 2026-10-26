# Short sports paper experiment

Follow tasks can enable realistic simulation and a single-game start horizon (for example72 hours), with an individually configured copy percentage, dedicated or shared cash, fee-inclusive exposure limit and optional per-order cap. Fresh installations do not create a follow task automatically.

The filter uses Gamma `gameStartTime` and supported single-game `sportsMarketType` values. Games already underway can qualify if the market is accepting orders. End dates are not settlement or redemption promises. Tournament/season winner markets, unknown schedules, and unsupported sports types are skipped. Selling existing positions and settlement are not subject to the time filter.

Realistic simulation rounds BUY input USD and SELL input shares down to two decimal places as the deployed SDK does. BUY requests below $1 are skipped, based on confirmed live exchange rejections. CLOB `min_order_size` / compact CLOB `mos` is treated as the minimum requested shares; Gamma's differently documented `orderMinSize` is not substituted. Tick grids and asset precision are checked. Requests are never accumulated or raised to $1; funds/cap limitations skip the whole requested trade rather than shrinking it. A valid FAK request may match only part of available depth. Paper execution still uses a local order book and approximate cash-equivalent fees; it cannot prove identical matching or fee results on the exchange.

For a current notification with an otherwise qualifying amount and missing sports metadata, a bounded lookup loads the required policy and continues that same notification. Failed lookups stop after at most three attempts. Small signals below the minimum buy amount do not trigger this lookup. Background warming prepares recent market schedules for later notifications. No skipped historical trades are replayed.

Task settings include the simulation switch and editable game-start horizon. Task rows show durable skip counts grouped by reason, latest example market, and oldest open holding age. Positions show holding age. Statistics flush every five seconds and never create financial orders or outbox purchase jobs. Existing first-buy event ratio locks remain in effect.

Public references: [Order construction](https://docs.polymarket.com/trading/place-orders), [Resolution](https://docs.polymarket.com/concepts/resolution). Input rounding was also checked against the installed official SDK 0.13.0 `computeMarketOrderAmounts` and `resolveRoundingConfig` sources.
