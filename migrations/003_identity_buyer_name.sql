-- Buyer identity: store display name and source for vendor notifications and greetings
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS buyer_name_source TEXT;

COMMENT ON COLUMN sessions.buyer_name IS 'Display name for the buyer (from WhatsApp profile or conversation)';
COMMENT ON COLUMN sessions.buyer_name_source IS 'One of: whatsapp_profile, conversation, self_provided';
