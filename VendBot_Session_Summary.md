# VendBot — Session Summary
*Everything discussed, decided, and agreed*

---

## 1. What VendBot Is

WhatsApp-native AI commerce platform for Nigerian vendors. One dedicated bot number, unlimited vendor stores, all activity inside WhatsApp. No app downloads, no website, no logins.

**Revenue model:** 5% per transaction. No monthly fee. Vendors pay when they earn.

---

## 2. Core Architecture — Agreed Stack

| Layer | Tool | Decision |
|-------|------|----------|
| WhatsApp | Baileys | Single dedicated SIM, never personal |
| Intent classification | Groq (llama3-8b-8192) | Fast, cheap, Nigerian Pidgin aware |
| Response generation | Kimi K2 via NVIDIA API | Replaced original Groq responder |
| Payments | Paystack | Replaced Mono — subaccounts for auto-split |
| Database | Neon (PostgreSQL via pg) | Replaced Supabase JS client |
| Hosting | Koyeb | Persistent volume for Baileys auth |
| Inventory (primary) | WhatsApp-native (DB) | Natural language, photos, voice notes |
| Inventory (advanced) | Google Sheets | For vendors who already use spreadsheets |

---

## 3. The Bot Number — Agreed Rules

- One dedicated SIM. MTN or Airtel. Nobody's personal number.
- Get the **permanent number now** and test with it. Do not use a test number that gets swapped later — every store link would break.
- QR code is scanned **once** by you on deployment. Vendors and buyers never see it.
- No linked devices on the bot number. Ever.
- Admin number is just an `.env` variable — can be changed anytime with zero user impact.

---

## 4. Vendor & Buyer Routing — How Context Switching Works

Same number can be both vendor and buyer. Context is determined entirely by **what they send**, not who they are.

| First word sent | Routed to |
|----------------|-----------|
| A store code (e.g. `AMAKA`) | Buyer flow at that store |
| `VENDOR-SETUP` | Vendor onboarding |
| Anything else (registered vendor) | Vendor management |
| Anything else (not a vendor) | Help message or fuzzy match |

- Sessions stored as `(buyer_jid, vendor_id)` pairs — never conflict
- Vendor buying from another vendor's store works perfectly
- Vendor accidentally texting their own store code → friendly redirect message
- `vendor_state` column added to handle mid-flow interruptions when vendor switches context

---

## 5. Vendor Onboarding Flow — Agreed Questions

Full conversational flow, no forms, entirely in WhatsApp:

1. Business name
2. Store code (3–15 chars, availability checked live)
3. **What do you sell?** (category — 6 options)
4. **Where are you based?** (city/area)
5. **Do you deliver?** (4 options: nationwide / local / pickup / depends)
6. **How quickly do you fulfil orders?** (same day / 1–2 days / 3–5 days / depends)
7. **How do you want your assistant to sound?** (professional / friendly / playful / Pidgin)
8. **One thing buyers should know** (free text or SKIP)
9. **Inventory method** — WhatsApp-native or Google Sheets
10. Bank name → account number → Paystack account verification → name confirmation
11. BVN verification (delayed — see Section 8)
12. Terms agreement → AGREE → store live

---

## 6. Inventory Management — Two Paths

### Path 1 — WhatsApp Native (default)
For vendors who are not technical. No spreadsheet needed.

- **Photo + caption** → AI parses name, price, quantity
- **Voice note** → Groq Whisper transcribes → AI parses
- **Plain text** → Natural language, any format, any dialect
- AI extracts structured data, confirms with vendor before saving
- All inventory stored in database

Commands:
```
show my items     → see full inventory
black bag don finish  → mark out of stock
i don restock the black bag, get 5 now  → restock
change black shoe to 13500  → update price
remove ankara dress  → remove item (with disambiguation)
```

### Path 2 — Google Sheets (for stock-managed vendors)
- Vendor pastes Google Sheet link during onboarding
- Bot reads live from sheet, decrements quantity after confirmed sales
- Template link provided so vendors don't have to build the structure themselves
- Service account email shared for access

**Database flag:**
```sql
vendor.inventory_mode = 'whatsapp' | 'sheets'
```

---

## 7. AI Prompt Engineering — What Was Fixed

### Problems identified
- Bot repeating the same lines
- Drifting out of scope (answering unrelated questions)
- Generic phrases that feel fake
- Wrong intent classification in Nigerian context

### Fixes agreed

**Banned phrases — hardcoded never-use list:**
- "Absolutely!", "Great choice!", "Of course!", "Certainly!"
- "Feel free to", "Don't hesitate", "I'd be happy to"

**Vendor profile injected into every system prompt:**
```
Business name, category, location, delivery coverage,
turnaround time, tone preference, custom vendor note
```

**Tone options per vendor:**
- Professional and formal
- Friendly and casual
- Playful and fun
- Nigerian — mix of English and Pidgin (matches buyer's energy)

**Conversation history added:**
- Last 10 messages stored in `sessions.conversation_history`
- Passed into every AI call so model never repeats itself

**Out-of-scope hard block before AI sees it:**
```javascript
// Catches: "are you a bot", "who made you", "ChatGPT", etc.
// Returns fixed response, never reaches the model
```

**Classifier tightened:**
- Category context injected
- Explicit Nigerian Pidgin examples for every intent
- Negative examples added to prevent misrouting

---

## 8. KYC & Identity Verification — Agreed Approach

### The trust problem
Vendors are rightfully suspicious of WhatsApp bots asking for BVN. Approach must earn trust before making the ask.

### What was agreed

**Do not ask for BVN during onboarding.**

Delay the ask until after their first successful sale. Money lands in their account first. Trust is established. Then ask.

**Verification options:**
- BVN via Paystack BVN match endpoint (already integrated, no new vendor)
- CAC registration number as alternative for registered businesses
- Admin whitelist for vendors you know personally (`VERIFY: AMAKA TRUSTED`)

**Never store raw BVN.** Store a SHA-256 HMAC hash only. Enables permanent blacklisting without storing sensitive data.

**Tiered access — verification as an upgrade, not a gate:**

| Status | Daily Cap | Payout Hold |
|--------|-----------|-------------|
| Unverified | ₦50,000 | 72 hours |
| BVN Verified | ₦500,000 | 24 hours |
| CAC Verified | Custom | Same day eligible |
| Admin Whitelisted | Custom | Custom |

---

## 9. Commission Structure — Per Category

Not a flat 5% for everyone. Category-aware from day one.

| Category | Commission | Daily Cap | Escrow Hold |
|----------|-----------|-----------|-------------|
| Fashion & clothing | 6% | ₦50,000 | 48 hours |
| Beauty & skincare | 6% | ₦50,000 | 48 hours |
| Food & drinks | 4% | ₦30,000 | 12 hours |
| Electronics & gadgets | 3% | ₦200,000 | 72 hours |
| Home & furniture | 5% | ₦150,000 | 72 hours |
| Other | 5% | ₦50,000 | 48 hours |

Stored per vendor — not hardcoded. Admin can override anytime.

---

## 10. Payouts — Fully Automatic

Vendors never request payouts. Money moves on its own.

**Standard flow:**
```
Buyer pays → escrow holds → hold period elapses →
cron releases → money hits vendor account → bot notifies vendor
```

**Accelerated by buyer confirmation:**
If buyer confirms delivery early, escrow releases immediately regardless of hold period.

**Instant Payout Program:**
Unlocked automatically when vendor meets undisclosed criteria. Never published exact thresholds — prevents gaming.

Criteria (internal only):
- 10+ completed transactions
- Zero disputes in 30 days
- Delivery confirmation rate above 80%
- BVN verified or admin whitelisted
- Account older than 14 days

Graduation is **manual** — algorithm identifies candidates, admin approves. No auto-graduation.

**Early Release:**
Verified vendors can request early payout for a 0.5% fee.

---

## 11. Partial Release — For Flippers & Source-to-Order Vendors

**The problem:** Many Nigerian vendors use the buyer's payment to fund the purchase. Holding 100% breaks their business model entirely.

**The solution — Partial Release:**

```
Buyer pays ₦15,000
→ 60% released immediately (₦9,000) — vendor sources item
→ 40% held until delivery confirmed (₦6,000) — buyer protection
```

Release splits by fulfilment model:

| Model | Immediate | Held |
|-------|-----------|------|
| Has stock | 0% | 100% |
| Sources after payment | 60% | 40% |
| Custom/made to order | 50% | 50% |
| Mixed | 30% | 70% |

Vendors with instant payout or clean record get more released immediately. Vendors with disputes get less.

**New onboarding question added:**
> "How do you usually fulfil orders? 1-Stock / 2-Source after payment / 3-Custom / 4-Mixed"

---

## 12. Escrow Communication — Agreed Language

Never use the word "escrow" with vendors or buyers. Never say "held."

| ❌ Never say | ✅ Always say |
|-------------|--------------|
| "held" | "protected" |
| "delayed" | "secured until delivery" |
| "escrow" | "VendBot protection" |
| "we are holding your money" | "your money is safe with us" |
| "you have to wait" | "it releases the moment you confirm" |
| "policy" | "how we protect you" |

**The one line that explains it to anyone:**
> "The vendor gets paid the moment the buyer is happy. The buyer gets their money back if they're not. Everyone is protected. Nobody gets cheated."

---

## 13. Fraud Prevention — What Was Built

### Wash trading detection
Vendors told vague criteria on purpose — "better performance = better terms" — so they cannot reverse-engineer exact thresholds to game graduation.

Detection layers:

1. **Velocity patterns** — same buyer 5+ times in 7 days, transactions under 5 mins apart, suspiciously round amounts
2. **Network graph / vendor rings** — if Vendor A buys from Vendor B and Vendor B buys from Vendor A more than twice in 30 days, both flagged
3. **Instant confirmations** — delivery confirmed under 5 minutes of payment, 3+ times, flagged
4. **Manual graduation** — no vendor auto-graduates to instant payouts, admin reviews and approves every case
5. **Higher reserve in first 30 days of instant payout** — even if they game graduation, fraud is capped

### Progressive reserve ratchet
If a vendor's weekly volume spikes above normal:

| Volume vs baseline | Reserve | Hold |
|-------------------|---------|------|
| Normal | 10% | Standard |
| 1.5x | 15% | +12hrs |
| 2x | 25% | +24hrs |
| 3x+ | 40% | 72hrs minimum + admin alert |

---

## 14. Delivery Accountability System

After every sale the bot asks the vendor:
> "How are you delivering? 1-Personal / 2-Driver / 3-Courier"

**Personal delivery:**
- Vendor replies `DELIVERED` when item handed over
- Buyer gets confirmation ping with YES/NO prompt

**Driver delivery:**
- Bot asks for driver's WhatsApp number
- Driver briefed automatically with order details and buyer contact
- Driver replies `DONE` or `ISSUE` with reason codes
- Both vendor and buyer notified

**Courier delivery:**
- Bot asks for tracking number + courier name
- Tracking link sent to buyer automatically
- Supports: GIG, Kwik, Sendbox, DHL, Topship

**Delivery confirmation:**
- Buyer confirms YES → escrow released immediately
- Buyer confirms NO → no_count incremented, dispute contact sent
- 3 NOs → vendor flagged
- 5 NOs → vendor auto-banned

---

## 15. Vendor Management Commands

```
ORDERS          — see all pending orders
BALANCE         — itemised payout breakdown
DELIVERED       — mark top pending personal delivery as delivered
TAKEOVER: [num] — bot goes silent, vendor handles buyer manually
HANDBACK: [num] — bot resumes with that buyer
```

**Admin commands (admin number only):**
```
TIER: [code] [tier] [cap]  — set vendor tier and cap
STATUS: [code]             — full vendor snapshot
BAN: [code]                — permanent ban
CAP: [code] [amount]       — change daily cap
REFUND: [ref] FULL/[pct]   — process refund
INSTANT: [code]            — grant instant payouts manually
VERIFY: [code] TRUSTED     — whitelist vendor, skip BVN
RESERVE                    — view platform reserve balance
WATCH: [code]              — flag vendor for monitoring
```

---

## 16. What Was Explicitly Decided Against

| Idea | Decision | Reason |
|------|----------|--------|
| Waitlist feature | Skip for MVP | Vendors don't have predictable restock patterns yet |
| Lending / credit product | Removed entirely | Not the business right now |
| Test number first | No | Get permanent number now, test with it |
| Auto-graduation to instant payouts | No | Manual admin approval only |
| Publishing exact graduation criteria | No | Enables wash trading |
| Asking for BVN during onboarding | No | Earn trust first, ask after first sale |
| Storing raw BVN/NIN | No | Hash only, never raw |
| Google Sheets as only inventory option | No | WhatsApp-native is the default |

---

## 17. Vendor Research — Questions to Ask Your Network

For casual one-on-one conversations. Pick 2–3, not all at once.

1. "When someone pays you on WhatsApp right now, what's the most stressful part?"
2. "Has anyone ever not paid you after agreeing to buy? What happened?"
3. "How do you currently know when something is sold out?"
4. "If someone held the buyer's payment until delivery — would you use it or prefer direct bank transfer?"
5. "How long can you wait for your money after a sale before it becomes a problem?"
6. "What do your buyers complain about most?"
7. "Do your buyers ever ghost after you've sourced the item for them?"
8. "If I could show you something that handles buyer conversations, takes payment securely, and pays you automatically — what would make you say no?"

---

## 18. Files Produced This Session

| File | Description |
|------|-------------|
| `AGENT.md` | Complete build guide — 26 steps, all code, final version with all updates baked in |
| `vendbot-flow.jsx` | Interactive flow reference — vendor and buyer, every step, collapsible |
| `VendBot_Session_Summary.md` | This document |

---

*Last updated: February 2026*
