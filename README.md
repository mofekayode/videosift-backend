# VidSift Backend Service

A dedicated Node.js backend service for handling long-running tasks in VidSift, including channel processing, video transcript processing, and streaming chat responses.

## Features

- **Channel Processing**: Fetch and process YouTube channels with their videos
- **Video Processing**: Download transcripts, generate embeddings, and store chunks
- **Chat Streaming**: Real-time streaming responses with OpenAI integration
- **Background Jobs**: Cron-based processing for pending tasks
- **No Timeout Limits**: Designed for long-running operations

## Prerequisites

- Node.js 18+ 
- Supabase project with proper schema
- OpenAI API key
- YouTube Data API key

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

4. Run the service:
```bash
# Development
npm run dev

# Production
npm start
```

## Environment Variables

- `PORT`: Server port (default: 4000)
- `NODE_ENV`: Environment (development/production)
- `BACKEND_API_KEY`: API key for authenticating requests
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `OPENAI_API_KEY`: OpenAI API key for chat and embeddings
- `YOUTUBE_API_KEY`: YouTube Data API key

## API Endpoints

### Channel Processing
- `POST /api/channels/process` - Start processing a channel
- `GET /api/channels/:channelId/status` - Get channel processing status

### Video Processing  
- `POST /api/videos/process` - Process a single video
- `GET /api/videos/:videoId/summary` - Get or generate video summary

### Chat
- `POST /api/chat/stream` - Stream chat responses (SSE)
- `POST /api/chat/sessions` - Create new chat session
- `GET /api/chat/sessions/:sessionId/messages` - Get chat history

### Monitoring
- `GET /api/monitor/stats` - Get system statistics
- `POST /api/monitor/trigger-cron` - Manually trigger processing

## Cron Jobs

- **Channel Processing**: Runs every minute to process pending channels
- **New Video Check**: Runs every 6 hours to check for new videos

## Architecture

```
backend/
├── src/
│   ├── server.js           # Express server setup
│   ├── routes/
│   │   └── api.js          # API route definitions
│   ├── services/
│   │   ├── channelProcessor.js  # Channel processing logic
│   │   ├── videoProcessor.js    # Video transcript processing
│   │   └── chatService.js       # Chat streaming service
│   └── middleware/
│       └── auth.js         # Authentication middleware
├── package.json
├── .env.example
└── README.md
```

## Deployment

This service is designed to run on platforms that support long-running processes like:
- Sevalla
- Railway
- Render
- DigitalOcean App Platform
- AWS EC2/ECS
- Google Cloud Run

## Security

- All API endpoints require authentication via `X-API-KEY` header
- CORS is configured for allowed origins only
- Environment variables for sensitive credentials

## Error Handling

- Graceful error handling for API failures
- Retry logic for rate-limited requests
- Detailed logging for debugging

## Performance

- Parallel processing of videos (3 concurrent)
- Batch embedding generation to avoid rate limits
- In-memory tracking to prevent duplicate processing
- Efficient chunking algorithm for transcripts