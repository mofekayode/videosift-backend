-- Create the search_transcript_chunks function for similarity search
CREATE OR REPLACE FUNCTION search_transcript_chunks(
  query_embedding vector(1536),
  video_id uuid,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  chunk_index int,
  start_time int,
  end_time int,
  text_preview text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tc.id,
    tc.chunk_index,
    tc.start_time,
    tc.end_time,
    tc.text_preview,
    1 - (tc.embedding <=> query_embedding) AS similarity
  FROM transcript_chunks tc
  WHERE 
    tc.video_id = search_transcript_chunks.video_id
    AND tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Create index for faster similarity search
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_embedding 
ON transcript_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create index for video_id lookups
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_video_id 
ON transcript_chunks (video_id);

-- Create processing_locks table if it doesn't exist
CREATE TABLE IF NOT EXISTS processing_locks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_id text NOT NULL UNIQUE,
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  holder_id text,
  created_at timestamptz DEFAULT now()
);

-- Create index for resource_id lookups
CREATE INDEX IF NOT EXISTS idx_processing_locks_resource_id 
ON processing_locks (resource_id);

-- Create cleanup function for expired locks
CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM processing_locks
  WHERE expires_at < now();
END;
$$;

-- Optional: Create a cron job to cleanup expired locks (requires pg_cron extension)
-- SELECT cron.schedule('cleanup-expired-locks', '*/5 * * * *', 'SELECT cleanup_expired_locks();');