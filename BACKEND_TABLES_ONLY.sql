-- ============================================
-- VidSift Backend Tables Only
-- Run this if the full migration fails
-- ============================================

-- 1. PROCESSING LOCKS TABLE
CREATE TABLE IF NOT EXISTS processing_locks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  lock_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_processing_locks_resource_id ON processing_locks (resource_id);
CREATE INDEX IF NOT EXISTS idx_processing_locks_expires_at ON processing_locks (expires_at);

-- Add RLS policies
ALTER TABLE processing_locks ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can manage locks" ON processing_locks
  FOR ALL USING (auth.role() = 'service_role');

-- 2. RATE LIMITS TABLE
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits (identifier, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_created_at ON rate_limits (created_at);

-- Add RLS policies
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Only service role can access rate limits
CREATE POLICY "Service role can manage rate limits" ON rate_limits
  FOR ALL USING (auth.role() = 'service_role');

-- 3. ERROR LOGS TABLE
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Error',
  stack TEXT,
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_type ON error_logs (type);

-- Add RLS policies
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- Only service role can access error logs
CREATE POLICY "Service role can manage error logs" ON error_logs
  FOR ALL USING (auth.role() = 'service_role');

-- 4. CRON LOGS TABLE
CREATE TABLE IF NOT EXISTS cron_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_cron_logs_job_name ON cron_logs (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_logs_status ON cron_logs (status);

-- Add RLS policies
ALTER TABLE cron_logs ENABLE ROW LEVEL SECURITY;

-- Only service role can access cron logs
CREATE POLICY "Service role can manage cron logs" ON cron_logs
  FOR ALL USING (auth.role() = 'service_role');

-- 5. UPDATES TO EXISTING TABLES
-- Add column to channel_queue for retry tracking
ALTER TABLE channel_queue 
ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;

-- Add columns to videos for queue tracking
ALTER TABLE videos
ADD COLUMN IF NOT EXISTS processing_queued BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS processing_queued_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS processing_queued_by UUID REFERENCES auth.users(id);

-- Create index for queued videos
CREATE INDEX IF NOT EXISTS idx_videos_processing_queue 
ON videos (processing_queued, transcript_cached, processing_queued_at)
WHERE processing_queued = true AND transcript_cached = false;

-- ============================================
-- Tables Created Successfully!
-- ============================================