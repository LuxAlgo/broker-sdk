# Bitunix USDT futures

The `bitunix` adapter uses a read-only API key for one main account. Create a key
with the minimum permissions needed for account, position and trade history,
without trading or withdrawal permissions. Supported margin currency is USDT;
the normalized account keeps `currency: "USDT"`, without converting it to USD.

```ts
import { connect } from "@luxalgo/broker-sdk";

const connection = connect({
  broker: "bitunix",
  credentials: {
    apiKey: process.env.BITUNIX_API_KEY!,
    apiSecret: process.env.BITUNIX_API_SECRET!,
  },
});
const snapshot = await connection.fetchSnapshot();
```

All requests are signed GETs to `https://fapi.bitunix.com` using injected
`ctx.fetch`. Redirects are refused. The adapter reads `/api/v1/futures/account`,
`get_pending_positions`, `get_history_positions` and `get_history_trades`.
It does not call order-placement, transfer or configuration endpoints.
The signature follows the official [signing specification](https://www.bitunix.com/api-docs/futures/common/sign.html).

History is read in pages of 100 until a short page. The first sync asks for fills
from Unix epoch to a fixed request-start time; this reads the history the API
actually exposes, without promising that the exchange retains an all-time archive.
If that range is rejected by the API, the sync fails; it does not silently replace
it with a short default window. A caller can supply `historySince` to choose an
explicit start. On later syncs callers should retain their earlier executions and
request an overlapping recent period, as Trade Journal already does.

Position discovery has no creation-time cutoff: an old opening may have a recent
close. History and pending positions are combined by position ID. History can
include still-open positions; current quantities come only from pending positions.
Pending requests explicitly set `includeSubAccounts=false`. Multiple observed
source account IDs cause an error. Main/subaccount traversal is not implemented.

Hedge fills in the live sample lack `positionId` and `tradeSide`. To associate
them with the position side, the adapter also fetches fills by each discovered
Hedge position ID, with the same time window. This initial implementation queries
all discovered Hedge positions on each sync; large accounts may require many
requests. It favors a verifiable association over guessing from `reduceOnly`.
Unmatched Hedge fills fail the snapshot instead of being silently netted.

The normalizer:

- Accepts observed BUY/SELL position labels as well as documented LONG/SHORT.
- Uses the fill's price and quantity; never reconstructs fills from position
  averages or `maxQty`. Market order prices are not used.
- Deduplicates fills by symbol and native trade ID; distinct identical partial
  fills survive. Execution IDs remain internal to the adapter.
- Sets `assetClass: "futures"`, and `positionSide`/`positionEffect`/`positionId` for Hedge.
  The optional SDK `Trade.positionId` preserves the native position association.
  One-way non-reduce-only fills are left unlabeled because they may reverse a position.
- Preserves the native `positionId` on pending open positions in both Hedge and
  One-way modes. Only Hedge positions carry `positionSide`.
- Preserves the sign of a reported fill fee. It ignores position-level fee and
  funding totals, which must not be added to fill fees.
- Calculates equity as available + frozen + position margin + cross/isolated
  unrealized P&L. Bonus is not added again. Missing components fail rather than
  producing a fabricated balance. This formula still needs a live balance check.

SDK `computeStats` isolates FIFO lots by native position identity, so concurrent
Hedge positions on the same symbol and side do not consume each other's openings.
SDK `diffSnapshots` uses native IDs for both pending positions and fills: unchanged
or reordered pending positions stay quiet, lifecycle events retain the position
ID, and otherwise identical fills for different positions remain distinct.
One-way fills retain their existing unlabeled behavior; their pending position
IDs do not imply a native association for executions that may reverse a position.

Sequential requests are spaced below the documented 10 requests/sec/UID limit.
Network failures, server errors and rate-limit codes have bounded retries with
fresh signatures. Repeated pages, inconsistent identities, premature page endings
and the page safety limit fail the fetch. Provider error messages and credentials
are not included in SDK error text.

A full live fetch of a Hedge-mode account reconciled every position quantity,
fill fee and fill-derived P&L with the source data, including a still-open
position. Position-reported `realizedPNL` matched fill gross minus fees plus
signed funding, contrary to its documented gross description; funding stays
outside SDK trades. Exchange history retention is not guaranteed. The account
endpoint returned all required equity components, but equity still needs
comparison with the UI. One-way, negative fill fees, retries and simulated
pagination have unit coverage; One-way and rebates have not been verified on a
live account.
