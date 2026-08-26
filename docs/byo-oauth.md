# Bring-your-own-app brokers (OAuth)

Some brokers don't hand users an API key — they hand *developers* an OAuth app. These brokers still fit this SDK's rules (sanctioned API, your credentials, no LuxAlgo server), with one extra setup step: **you register your own free developer app** and use its client credentials. Your keys, including the app itself, stay yours.

Status: **shipped.** Both adapters are in the SDK (`etrade`, `coinbase`), with the flow helpers `createEtradeOAuthFlow`, `buildCoinbaseAuthorizeUrl`, and `exchangeCoinbaseCode` exported from `@luxalgo/broker-sdk/adapters`.

## How it will work

OAuth adapters need two things a key-based adapter doesn't:

1. **Your app's client id/secret** — passed as ordinary credential fields (`clientId`, `clientSecret`), exactly like an API key.
2. **A redirect flow** — the SDK cannot open a browser for you. It will expose the authorization URL to send your user to, and accept the callback code to exchange for tokens. Token refresh then flows through the existing `onCredentialsRotated` mechanism.

```ts
// Planned surface — not shipped yet
const flow = createOAuthFlow({ broker: "etrade", clientId, clientSecret, redirectUri });
const url = flow.authorizationUrl();          // send the user here
const credentials = await flow.exchange(code); // callback code → tokens
const connection = connect({ broker: "etrade", credentials, onCredentialsRotated: persist });
```

## E*TRADE

1. Sign in at [developer.etrade.com](https://developer.etrade.com) and request an individual API key (free; sandbox key is immediate, production key takes a short review).
2. You receive an OAuth 1.0a consumer key + secret. E*TRADE uses OAuth 1.0a with a verification-code flow — the SDK will handle the signing.
3. Scope is granted per session; tokens expire at midnight ET daily, so expect a re-auth prompt each trading day. That's E*TRADE's rule, not ours.

## Coinbase

1. Create an OAuth2 application at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) (free).
2. Request only read scopes: `wallet:accounts:read`, `wallet:transactions:read`.
3. Standard OAuth2 authorization-code flow with refresh tokens; rotation flows through `onCredentialsRotated`.

> Alternatively, Coinbase supports user-generated CDP API keys for some account types — if that covers your account, it may land as a plain key-based adapter instead, which would need no app registration at all.

## What will never be here

Aggregator-only institutions (Fidelity, Schwab, Chase…) require the *aggregator's* credentials, not yours — that can't ship in an open-source library, and pretending otherwise would mean scraping. See the README's "sanctioned APIs only" rule.
