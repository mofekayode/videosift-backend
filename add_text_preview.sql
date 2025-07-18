-- Add text_preview column to transcript_chunks if it doesn't exist
ALTER TABLE transcript_chunks 
ADD COLUMN IF NOT EXISTS text_preview TEXT;
EOF < /dev/null