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