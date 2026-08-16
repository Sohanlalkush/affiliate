# Pharmalite Affiliate Availability API

Availability + affiliate-link service for the `/druglist/go/<slug>` page on
pharmalite.in. Zero dependencies — plain Node.js (native `fetch`, Node >= 18).

## How it works

```
POST /availability   (also POST /)
{ "slug": "dolo-650-tablet", "name": "Dolo 650 Tablet",
  "composition": "Paracetamol (650mg)", "strength": "650mg",
  "form": "tablet", "manufacturer": "Micro Labs Ltd" }

200 → { "ok": true, "url": "<final url>", "partner": "netmeds|truemeds|amazon" }
```

Partner resolution, in order of preference (`PREFERRED_PARTNER`):

1. **Netmeds** — search `q=<term>`, take the first result where
   `sellable === true` **and** the name actually matches the term, return
   `https://www.netmeds.com/product/{slug}`. The name check is required:
   Netmeds answers a no-results query with a random 12-item fallback list
   (all sellable), so "first sellable" alone would send visitors to shampoo.
2. **Truemeds** — search suggestions, filter to products where
   `available === true` whose `skuName` matches the term (substitutes are
   a different medicine and are filtered out), pick the one with the LOWEST
   `sellingPrice`, build `https://www.truemeds.in/{productUrlSuffix}`, then
   convert it through the Ekaro converter (`convert_only`) into the affiliate
   shortlink.
3. **Amazon backup** — `https://www.amazon.in/s?k=<term>&tag=pharmalite-21`.
   Used when both partners fail, any call errors/times out, the Ekaro token
   is missing, or the overall 14.5 s deadline is hit — so the browser always
   gets a URL.

The search term is `name`, falling back to the deslugified `slug`, then
`composition`. Only `slug` is guaranteed by the caller; the API works with it
alone.

## Run

```bash
npm start          # or: node server.mjs     (port 8787 by default)
npm test           # smoke test against the running server
```

`EARNKARO_API_TOKEN` in `.env` is the only required secret. Without it the
Truemeds path is skipped and the Amazon backup is used.

## Environment (`.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | listen port |
| `ALLOWED_ORIGIN` | `https://pharmalite.in,http://localhost:4321` | CORS origins, comma separated |
| `EARNKARO_API_TOKEN` | *(empty)* | Ekaro bearer token — paste it here when you get it |
| `AMAZON_TAG` | `pharmalite-21` | tag on the Amazon backup URL |
| `NETMEDS_TIMEOUT_MS` | `6000` | per-call timeout for the Netmeds search |
| `TRUEMEDS_TIMEOUT_MS` | `8000` | per-call timeout for the Truemeds search |
| `EKARO_TIMEOUT_MS` | `6000` | per-call timeout for the Ekaro converter |
| `TOTAL_TIMEOUT_MS` | `14500` | hard cap for the whole request; Amazon backup returned after this |
| `PREFERRED_PARTNER` | `first` | `first` = Netmeds wins when both succeed · `netmeds` · `truemeds` |

## CORS

Answered on every response: `Access-Control-Allow-Origin: <allowed origin>`,
`Access-Control-Allow-Headers: content-type`, `Access-Control-Allow-Methods:
POST, GET, OPTIONS`. A request from an origin not in `ALLOWED_ORIGIN` gets a
403. `GET /health` reports `{ok, uptime, tokenConfigured}`.

## Wiring into pharmalite

In `projects/Pharmalite/src/lib/affiliate-config.ts` set:

```ts
export const AVAILABILITY_API = "https://<your-host>/availability";
```

The `/druglist/go` page then POSTs the payload above and navigates to the
returned `url` (it is validated by `isSafeOutboundUrl` first — keep it an
absolute `https://` URL). Note the page aborts the call after
`AVAILABILITY_TIMEOUT_MS` (default 8000) — the partner calls here normally
finish in 1–3 s, so 8 s is plenty; if you ever see "still checking" a lot,
raise that constant rather than the server budget.

## Notes

- Ekaro success shape expected: `{"success": 1, "data": "<url>"}`.
  `{"error": 1, "message": ...}`, 401, 429 or anything else → Truemeds
  treated as failed → Amazon backup.
- The Ekaro API rejects non-browser requests: without a browser
  `User-Agent`, `Origin` and `Accept` header it answers 401 "Please
  authenticate" even with a valid token. The server sends browser-like
  headers on that call.
- Both partners are queried in PARALLEL; Netmeds wins when both succeed
  (unless `PREFERRED_PARTNER` says otherwise).
- No logging of request bodies; only `term`, winner partner and latency are
  printed to stdout.