-- One post-onboarding store name change by vendor; after that, admin only.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_name_edits_used BOOLEAN DEFAULT false;
