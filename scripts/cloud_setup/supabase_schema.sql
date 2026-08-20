-- ==============================================================================
-- HackySack Cloud — Supabase Database Schema & RLS Policies (Fail-Proof)
-- ==============================================================================

-- 1. Create Subscriptions Table with Rate Limiting Fields
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  jwt_token TEXT UNIQUE NOT NULL,
  daily_request_count INT DEFAULT 0,
  daily_premium_count INT DEFAULT 0,
  last_request_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure column exists if table already created
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS daily_premium_count INT DEFAULT 0;

-- 2. Index for Fast Authentication Lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_jwt ON public.subscriptions(jwt_token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

-- 3. Row Level Security (RLS)
ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;
GRANT ALL ON public.subscriptions TO anon, authenticated, service_role;
