# WhatsApp anti-ban

VendBot uses **baileys-antiban** when available, and a built-in rate limiter otherwise, to reduce the risk of WhatsApp banning the bot number.

## Behaviour

- **When `baileys-antiban` loads** (package has a built `dist/`): full protection (rate limit, warm-up, health monitor, typing simulation). The socket is wrapped and all `sendMessage` calls go through it.
- **When the package is not available**: a simple built-in limiter runs:
  - Minimum delay between sends (default 1500 ms, with jitter)
  - Maximum messages per minute (default 12)
  - Same socket interface, so no code changes elsewhere

## Env vars

| Variable | Default | Description |
|----------|---------|--------------|
| `BAILEYS_ANTIBAN` | `1` (enabled) | Set to `0` or `false` to disable all antiban. |
| `BAILEYS_ANTIBAN_MIN_DELAY_MS` | `1500` | Fallback: min delay between sends (ms). |
| `BAILEYS_ANTIBAN_MAX_PER_MINUTE` | `12` | Fallback: max messages per minute. |

## Package note

The npm package `baileys-antiban` is ESM-only and may be published without a pre-built `dist/`. If you see in logs *"baileys-antiban not available; using simple rate limiter"*, the built-in limiter is active. To use the full package, the maintainer would need to publish a built bundle, or you can build it locally from the repo and link it.

## Health (when using full package)

If the full `baileys-antiban` is active, the socket has an `.antiban` object. You can log stats with:

```js
const { getSock } = require('./whatsapp/client');
const stats = require('./whatsapp/antiban').getStats(getSock());
console.log(stats);
```
