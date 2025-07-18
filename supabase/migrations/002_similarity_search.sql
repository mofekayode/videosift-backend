-- Create the similarity search function for transcript chunks
CREATE OR REPLACE FUNCTION search_transcript_chunks(
  query_embedding vector(1536),
  video_id uuid,
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
  WHERE tc.video_id = search_transcript_chunks.video_id
    AND tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Create index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_embedding ON transcript_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create the channel-wide similarity search function
CREATE OR REPLACE FUNCTION search_channel_chunks(
  query_embedding vector(1536),
  channel_id uuid,
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
  WHERE v.channel_id = search_channel_chunks.channel_id
    AND tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;