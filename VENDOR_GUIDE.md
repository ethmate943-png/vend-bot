# VendBot — Vendor Guide

How to manage your products, ask about stock, and upload inventory.

---

## 1. Asking about your products & stock

Use these **commands** in the same WhatsApp chat where you’re logged in as the vendor (your store number):

| What you want | What to send |
|---------------|--------------|
| See all stock | `list` or `inventory` |
| Add new items | `add: item name, price, quantity` (see below) |
| Mark one sold | `sold: item name` |
| Change quantity | `restock: item name, new quantity` or `set: item name, new quantity` |
| Message all past buyers | `broadcast: your message here` |
| Pending orders | `orders` |
| Last order’s buyer details | `DETAILS` |
| Mark last order delivered | `DELIVERED` or `TOMORROW` or `ISSUE` |

**Examples**

- *“What do I have?”* → Send: **list**
- *“I sold one black sneaker”* → Send: **sold: black sneaker**
- *“I now have 10 red bags”* → Send: **restock: red bag, 10** or **set: red bag, 10**
- *“Flash sale today”* → Send: **broadcast: Flash sale today**
- *“Who’s waiting for delivery?”* → Send: **orders** then **DETAILS** on the one you want to see

---

## 2. Ways to upload & keep stock

You can use **any** of these methods. They all update the same inventory (your Google Sheet or in-app list).

### A. Text (one or many items)

**Single item**

- `add: Black sneakers, 25000, 3`
- `add: Red bag 15k 1`

**Natural language (AI figures out name, price, qty)**

- `add: black sneakers 25k 3, red bag 15000 1`
- `add: laptop 120000, 2 in stock. wireless mouse 8500 each, 5`

**Multiple lines (bulk)**

Send one message with several lines; each line can be “name, price, qty” or natural language:

```
add:
Black sneakers, 25000, 3
Red bag, 15000, 1
Wireless mouse 8500 5
```

You can mix “name, price, qty” and short natural lines in the same message.

### B. Voice note

Send a **voice note** in the same vendor chat describing what you have:

- *“Add black sneakers, twenty-five thousand, three. Red bag, fifteen thousand, one.”*
- *“Restock: wireless mouse, 10.”*

The bot will transcribe the voice note, read out the items (and prices/quantities), and add or update stock. Same rules as text: say the item name, price in Naira, and quantity clearly.

### C. Google Sheet

If you set a **Google Sheet** during setup:

- Your Sheet is the main source of truth.
- `add:`, `sold:`, `restock:` and voice all update that same Sheet.
- You can also edit the Sheet directly; the bot reads from it when buyers ask for products.

So you have three ways to “keep stock”:

1. **Only WhatsApp** — Use `add:` / `sold:` / `restock:` (and voice) and optionally use **list** to check. You still need to link a Sheet in onboarding so the bot has somewhere to write.
2. **Only Sheet** — Edit the Sheet yourself; the bot uses it for buyers.
3. **Both** — Use WhatsApp for quick updates and the Sheet for bigger edits or reports.

---

## 3. Quick reference

| Command | Example |
|--------|--------|
| List stock | `list` |
| Add one item | `add: Black sneakers, 25000, 3` |
| Add many (one message) | `add: sneakers 25k 3, bag 15k 1` or multi-line under `add:` |
| Sold one | `sold: Black sneakers` |
| Set quantity | `restock: Black sneakers, 5` or `set: Black sneakers, 5` |
| Broadcast | `broadcast: Message to all past buyers` |
| Pending orders | `orders` |
| Buyer details | `DETAILS` |
| Delivery status | `DELIVERED` / `TOMORROW` / `ISSUE` |
| Voice stock | Send a voice note describing items (e.g. “add: …” or “restock: …”) |

---

## 4. Tips

- **Prices**: Use numbers only (e.g. `25000` or `25k`). No need to type “₦” or “Naira”.
- **Quantities**: Always give a number. If you don’t, the bot may assume 1.
- **Names**: Slightly different spelling is OK for `sold:` and `restock:` (e.g. “black sneaker” vs “Black sneakers”) as long as it matches one item in your list.
- **No sheet yet**: You must complete setup and link a Google Sheet (or choose SKIP and link later) so the bot has a place to store inventory. Until then, `add:` will ask you to set up your sheet first.

If something doesn’t work (e.g. “Could not understand”), try:

- Shorter, clearer lines: `add: Item name, price, quantity`
- One item per line in bulk messages
- In voice notes: speak clearly and mention “add” or “restock” and the numbers.
