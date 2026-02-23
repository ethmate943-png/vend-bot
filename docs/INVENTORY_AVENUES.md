# Inventory: Avenues to Upload & Update

Ways vendors can add and update stock, and how we can improve.

---

## Current avenues

| Avenue | How | Add | Update (qty) | Remove | Best for |
|--------|-----|-----|--------------|--------|----------|
| **WhatsApp text** | Commands as vendor | `add: name, price, qty` or `add: name, price, qty, image URL` | `restock: name, qty` or `set: name, qty` | `remove: name` (DB only) | Quick single/bulk adds, restock, sold |
| **WhatsApp voice** | Send voice note | “Add black sneakers 25k 3, red bag 15k 1” | — | — | Hands-free bulk add |
| **Google Sheet** | Link sheet at setup | Edit sheet (we read it) | Edit sheet | Delete row / set qty 0 | Spreadsheet users, bulk edit |
| **DB (Neon)** | No sheet linked | Same `add:` / voice | Same `restock:` / `set:` | `remove: name` | No spreadsheet; supports images |
| **Auto** | On payment | — | — | Qty -1 on paid order (webhook) | Sold items |

- **Add:** `add: Item name, price, quantity` or multi-line; optional 4th value = image URL (DB only). Voice: same info in natural language.
- **Update qty:** `restock: Item name, new qty` or `set: Item name, new qty`. `sold: Item name` = -1.
- **Remove (hide from list):** `remove: Item name` — sets quantity to 0 (DB) or vendor edits sheet.
- **Set image (DB only):** `image: Item name, image URL` — attach or change product image.

---

## Possible improvements

1. **CSV / file upload**  
   Vendor sends a CSV (or Excel) file; we parse and bulk insert. Needs: file download from WhatsApp, parse, then `addItems`. Good for large catalogs.

2. **Photo + caption as new item**  
   Vendor sends a product photo with caption “add: Name, price, qty”. We save the message’s image URL (or upload to storage) and set `image_url` for that item. Improves “add with photo” without pasting URLs.

3. **Image for existing item (done)**  
   `image: item name, URL` (or “set image: …”) so vendors can add/change product images without re-adding the item.

4. **Bulk price/restock**  
   e.g. “restock all: 5” to add 5 to every item, or “price update: 10%” (dangerous; would need confirmation). Lower priority.

5. **Duplicate / template**  
   “duplicate: Black sneakers” to create a new row with same name/price (qty 0 or 1) for variants. Or “copy: SKU” to clone an item.

6. **Categories / tags**  
   Already in schema (`category`). Expose in commands: “add: …, category: shoes” or “list category: shoes”. Filter buyer-facing list by category.

7. **Low-stock alerts**  
   Cron or webhook: when qty ≤ threshold (e.g. 2), notify vendor: “Black sneakers is low (2 left). Restock?”

8. **API or simple dashboard**  
   Optional HTTP API or web UI for vendors to upload CSV, edit qty, set images (with auth). Good for power users.

9. **Better fuzzy match**  
   For `sold:` / `restock:` / `remove:`, if name doesn’t match exactly, reply “Did you mean: X, Y?” from closest name matches.

10. **Format help**  
    When `add:` or `restock:` fails (e.g. can’t parse), reply with one-line examples: “Use: add: name, price, qty” or “restock: name, number”.

---

## Summary

- **Today:** WhatsApp (text + voice), Google Sheet (if linked), Neon DB (if no sheet), auto-decrement on payment. New: `remove:`, `image:` for DB.
- **Next steps:** CSV upload, photo-as-image for new items, low-stock alerts, and format/fuzzy-help make the biggest impact for little surface area.
