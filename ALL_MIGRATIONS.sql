-- ============================================
-- VidSift Backend Migrations
-- Run this entire file in Supabase SQL Editor
-- ============================================

-- 1. BASE SEARCH FUNCTION (001_search_function.sql)
-- This was likely already created, but included for completeness

-- 2. SIMILARITY SEARCH FUNCTIONS (002_similarity_search.sql)
-- Create the similarity search function for transcript chunks
CREATE OR REPLACE FUNCTION search_transcript_chunks(
  query_embedding vector(1536),
  p_video_id uuid,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  video_id uuid,
  chunk_index int,
  start_time int,
  end_time int,
  text_preview text,
  keywords text[],
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    tc.id,
    tc.video_id,
    tc.chunk_index,
    tc.start_time,
    tc.end_time,
    tc.text_preview,
    tc.keywords,
    1 - (tc.embedding <=> query_embedding) as similarity
  FROM transcript_chunks tc
  WHERE tc.video_id = p_video_id
    AND tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Create index for vector similarity search
-- NOTE: This may fail due to memory constraints. If it does, skip it for now.
-- You can create it later when you have fewer embeddings or more memory.
-- CREATE INDEX IF NOT EXISTS idx_transcript_chunks_embedding ON transcript_chunks 
-- USING ivfflat (embedding vector_cosine_ops)
-- WITH (lists = 100);

-- Create the channel-wide similarity search function
CREATE OR REPLACE FUNCTION search_channel_chunks(
  query_embedding vector(1536),
  p_channel_id uuid,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  video_id uuid,
  video_title text,
  chunk_index int,
  start_time int,
  end_time int,
  text_preview text,
  keywords text[],
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    tc.id,
    tc.video_id,
    v.title as video_title,
    tc.chunk_index,
    tc.start_time,
    tc.end_time,
    tc.text_preview,
    tc.keywords,
    1 - (tc.embedding <=> query_embedding) as similarity
  FROM transcript_chunks tc
  JOIN videos v ON v.id = tc.video_id
  WHERE v.channel_id = p_channel_id
    AND tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 3. PROCESSING LOCKS TABLE (003_processing_locks.sql)
-- Create the processing_locks table for distributed locking
CREATE TABLE IF NOT EXISTS processing_locks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  lock_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_resource_lock UNIQUE (resource_id)
);

-- Create index for faster lookups
CREATE INDEX idx_processing_locks_resource_id ON processing_locks (resource_id);
CREATE INDEX idx_processing_locks_expires_at ON processing_locks (expires_at);

-- Add RLS policies
ALTER TABLE processing_locks ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can manage locks" ON processing_locks
  FOR ALL USING (auth.role() = 'service_role');

-- 4. RATE LIMITS TABLE (004_rate_limits.sql)
-- Create the rate_limits table for tracking API usage
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL, -- Format: "user:uuid" or "ip:address"
  action TEXT NOT NULL, -- e.g., 'chat', 'video_upload', 'channel_process'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX idx_rate_limits_lookup ON rate_limits (identifier, action, created_at DESC);
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

-- 5. ERROR LOGS AND CRON LOGS (005_error_logs.sql)
-- Create error_logs table for tracking application errors
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Error',
  stack TEXT,
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX idx_error_logs_created_at ON error_logs (created_at DESC);
CREATE INDEX idx_error_logs_type ON error_logs (type);
CREATE INDEX idx_error_logs_context_path ON error_logs ((context->>'path')) WHERE context->>'path' IS NOT NULL;

-- Add RLS policies
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- Only service role can access error logs
CREATE POLICY "Service role can manage error logs" ON error_logs
  FOR ALL USING (auth.role() = 'service_role');

-- Create a cron_logs table for tracking cron job execution
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
CREATE INDEX idx_cron_logs_job_name ON cron_logs (job_name, started_at DESC);
CREATE INDEX idx_cron_logs_status ON cron_logs (status);

-- Add RLS policies
ALTER TABLE cron_logs ENABLE ROW LEVEL SECURITY;

-- Only service role can access cron logs
CREATE POLICY "Service role can manage cron logs" ON cron_logs
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Migration Complete!
-- ============================================