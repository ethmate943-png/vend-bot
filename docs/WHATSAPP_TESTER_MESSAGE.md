# Message to Send Your Tester on WhatsApp

Copy one of the versions below and send it to your tester. Replace `YOUR_BOT_NUMBER` with the actual number (e.g. `2349159165954`) so the link works.

---

## Short version (paste into WhatsApp)

```
Hey! Here’s how to test our store bot on WhatsApp 👇

1️⃣ Open the store (save the number or use this link):
https://wa.me/YOUR_BOT_NUMBER

2️⃣ As a BUYER try:
• Ask: "Do you have [product name]?"
• Say: "I want it" or "I'll take it" when you see something you like
• You’ll get a payment link — you can pay with test card or just check that the link works
• You can also try: "Can you do 20000?" (negotiation), "resend" (new link), "cancel"

3️⃣ If you’re testing as VENDOR (same number, after setup):
• Add stock: add: Blue shirt, 15000, 5
• See list: list
• Orders: orders … then DELIVERED / DETAILS
• Help: type help or stock help

Reply with what worked or what broke. Thanks! 🙏
```

---

## Even shorter (2 messages)

**Message 1**
```
Test our store bot 🛒
Open: https://wa.me/YOUR_BOT_NUMBER
```

**Message 2**
```
As buyer: ask "Do you have X?" then say "I want it" — you’ll get a payment link.
As vendor: add: Item, price, qty … or type "list" / "help".
Tell me what breaks or feels odd 👍
```

---

## With your real number (example)

If your bot number is **2349159165954**:

```
Hey! Here’s how to test our store bot on WhatsApp 👇

1️⃣ Open: https://wa.me/2349159165954

2️⃣ As BUYER:
• "Do you have black sneakers?" → then "I want it"
• You’ll get a payment link (test card is fine)
• Also try: "Can you do 20000?" or "cancel"

3️⃣ As VENDOR (if we set you up):
• add: Blue shirt, 15000, 5
• list | orders | help

Reply with what worked or what broke. Thanks! 🙏
```

---

**Tip:** Send the link first so they can open the chat in one tap. Then send the “what to try” part.

---

## “How do I add stock if the number is my own?”

With **one number per store**, the store number is yours. To add stock you don’t chat with another person — you **message your own store number** (the bot):

1. Open WhatsApp.
2. Open the chat with **your store number** (the same number you used to scan the QR / that’s in the wa.me link).
3. Send: `add: Item name, price, qty` or `list`, `help`, etc.

The bot on that number treats messages from you as **vendor** commands and replies in that same chat. Buyers also message that same number; you’ll see their chats in the same WhatsApp account. So you’re not “chatting yourself” — you’re just using that chat as the interface to manage your store.

---

## “How does the bot know the message is from the vendor?”

We **don’t** use a special “chat yourself” flag from Baileys. We use two things:

1. **Vendor = store number in the DB**  
   When you completed setup, your store’s WhatsApp number was saved in `vendors.whatsapp_number`. The bot only has one number per store (the one that scanned the QR).

2. **Sender = that number → vendor**  
   Every incoming message has a sender (the WhatsApp JID). We compare the sender’s phone number to `vendor.whatsapp_number`. If they match → we treat it as a **vendor** message (add stock, orders, broadcast, etc.). If they don’t match → we treat it as a **buyer** (browse, buy, pay).

So: any message **from** the store number is treated as the vendor. When you “message your store”, you’re sending from that number, so the bot sees the sender and runs vendor commands. We also allow **“message yourself”** (note to self) so that when you send a message in the chat with your own number, it isn’t filtered out and is still processed as a vendor command.
