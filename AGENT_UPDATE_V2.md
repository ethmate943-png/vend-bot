# AGENT_UPDATE_V2.md — VendBot Updates (Priority Ordered)

> Read AGENT.md first. Then apply every update in this file in the exact order listed.
> Where this file conflicts with AGENT.md — this file wins.
> Do not skip updates. Do not reorder them. Build each one fully before moving to the next.

---

## What Changed & Why (Summary)

| Area | Change | Reason |
|------|--------|--------|
| Infrastructure | Render + Supabase → Koyeb + Neon | Cheaper, always-on, no connection limits |
| Payments | Mono → Paystack + Subaccounts | No AML cert needed, vendors paid same day |
| Vendor routing | Single number + store codes | One connection, unlimited vendors |
| Fraud | Tier system + caps + ratchet | Scammers can't collect millions on day one |
| Delivery | Driver integration | Third party witness for disputes |
| Cart | Multi-item support | Most vendors sell complementary items |
| Concurrency | p-queue + worker pool | Handles scale without new infrastructure |

---

# 🔴 CRITICAL — Build These Before Anything Else

---

## UPDATE 1 — Block Group Chat Messages

**File:** `src/whatsapp/listener.js`

Add as the absolute first line inside `handleMessage`, before any other logic:

```javascript
if (buyerJid.endsWith('@g.us')) return;
```

---

## UPDATE 2 — Global Error Handler

**File:** `src/index.js`

Add before the `main()` call:

```javascript
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  if (error.message?.includes('FATAL')) process.exit(1);
});
```

---

(Full document content is in the user message — this file is a placeholder; implementing from the user's paste.)
