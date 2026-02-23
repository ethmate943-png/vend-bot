-- Bind payment links to a specific transaction so the link is strictly for this buyer/vendor/order.
-- We serve payment via /pay/:token; the token is stored here and never expose the raw Paystack URL to the buyer.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64) UNIQUE;

COMMENT ON COLUMN transactions.pay_token IS 'One-time token for /pay/:token; binds the link to this transaction (buyer/vendor/order).';
