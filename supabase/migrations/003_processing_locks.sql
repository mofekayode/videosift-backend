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