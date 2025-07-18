# Backend Implementation Guide

## Overview

The backend has been enhanced with all the necessary logic that was previously in the frontend (Vercel). This includes:

- Video transcription and processing
- Channel indexing and processing
- Embeddings generation and RAG search
- Streaming chat responses (both video and channel)
- Queue management and background tasks
- Distributed locking for concurrent processing
- Rate limiting
- Error tracking and monitoring
- Cron jobs for automated processing

## New Services Implemented

### 1. RAG Service (`src/services/ragService.js`)
- Generates embeddings using OpenAI text-embedding-ada-002
- Implements hybrid search (semantic + keyword)
- Handles both video and channel-wide searches
- Retrieves full transcript text from storage
- Includes embedding caching for performance

### 2. Lock Service (`src/services/lockService.js`)
- Distributed locking using database
- TTL-based locks with automatic cleanup
- Prevents duplicate processing across instances
- Handles expired lock detection and cleanup

### 3. Queue Service (`src/services/queueService.js`)
- Channel and video queue management
- Priority-based processing
- Automatic retries for failed items
- Queue position tracking
- Background video processing

### 4. Error Tracker (`src/services/errorTracker.js`)
- Comprehensive error logging to database
- API error tracking with context
- Error statistics and reporting
- Automatic cleanup of old errors
- Uncaught exception handling

## Enhanced Features

### Chat Service Enhancements
- Added channel-wide streaming chat support
- Integrated RAG search for better context retrieval
- Improved citation tracking
- Support for multiple video contexts

### Channel Processor Enhancements
- Distributed locking to prevent duplicate processing
- Better error handling and retry logic
- Email notifications on completion

### Video Processor Enhancements
- Distributed locking for concurrent safety
- Improved transcript processing
- Better error recovery

## New API Endpoints

### Chat Endpoints
- `POST /api/chat/channel/stream` - Stream chat responses for entire channels

### Queue Endpoints
- `POST /api/queue/channel` - Enqueue channel for processing
- `POST /api/queue/video` - Enqueue video for processing
- `GET /api/queue/status` - Get overall queue status
- `GET /api/queue/position/:queueItemId` - Get queue position
- `POST /api/queue/process-videos` - Manually trigger video processing

### Monitoring Endpoints
- `GET /api/errors/stats` - Get error statistics
- `GET /api/cron/status` - Get cron job status and history

## Rate Limiting

All major endpoints now include rate limiting:
- Chat endpoints: Limited by user type
- Video/Channel processing: Limited to prevent abuse
- Configurable limits for anonymous/user/premium tiers

## Database Migrations

Run the following migrations in order:
1. `001_search_function.sql` - Base search functionality
2. `002_similarity_search.sql` - Vector similarity search functions
3. `003_processing_locks.sql` - Distributed locking table
4. `004_rate_limits.sql` - Rate limiting and queue tracking
5. `005_error_logs.sql` - Error and cron logging tables

## Environment Variables

Ensure these are set:
```env
# Existing
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_key
OPENAI_API_KEY=your_openai_key
YOUTUBE_API_KEY=your_youtube_key

# New/Updated
PORT=4000
NODE_ENV=production
ALLOWED_ORIGINS=https://vidsift.com,http://localhost:3000
```

## Frontend Integration

Update frontend API calls to use the new backend:

```javascript
// Example: Use backend for channel chat
const response = await fetch(`${BACKEND_URL}/api/chat/channel/stream`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    messages,
    channelId,
    sessionId
  })
});

// Handle streaming response
const reader = response.body.getReader();
// ... process stream
```

## Deployment to Sevalla

1. Ensure all environment variables are set
2. Run database migrations
3. Deploy the backend code
4. Configure appropriate resources:
   - Minimum 2GB RAM for embeddings generation
   - Consider using multiple instances for high availability
   - Set up monitoring for cron jobs

## Monitoring

- Check `/api/monitor/stats` for system health
- Monitor `/api/cron/status` for job execution
- Review `/api/errors/stats` for error trends
- Set up alerts for failed cron jobs

## Performance Considerations

1. **Embedding Cache**: In-memory cache reduces API calls
2. **Distributed Locks**: Prevents duplicate processing
3. **Rate Limiting**: Protects against abuse
4. **Queue System**: Handles burst traffic gracefully
5. **Error Tracking**: Identifies issues quickly

## Security

- All sensitive endpoints require authentication
- Rate limiting prevents abuse
- Error messages sanitized in production
- Distributed locks prevent race conditions
- Service role key only used server-side