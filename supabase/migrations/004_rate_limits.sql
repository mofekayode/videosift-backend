-- Create the rate_limits table for tracking API usage
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL, -- Format: "user:uuid" or "ip:address"
  action TEXT NOT NULL, -- e.g., 'chat', 'video_upload', 'channel_process'
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Index for efficient querying
  INDEX idx_rate_limits_lookup (identifier, action, created_at DESC)
);

-- Create index for cleanup queries
CREATE INDEX idx_rate_limits_created_at ON rate_limits (created_at);

-- Add RLS policies
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Only service role can access rate limits
CREATE POLICY "Service role can manage rate limits" ON rate_limits
  FOR ALL USING (auth.role() = 'service_role');

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