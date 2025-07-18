# VidSift Backend Deployment Guide

## Pre-Deployment Checklist

### ✅ Ready for Deployment:
- Node.js backend with Express
- ES modules configuration
- Health check endpoint at `/health`
- Isolated channel processing functionality
- Email notifications via Resend
- Proper error handling and logging

### ⚠️ Required Environment Variables:
```env
PORT=4000
OPENAI_API_KEY=your_openai_key
YOUTUBE_API_KEY=your_youtube_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
BACKEND_API_KEY=your_secure_api_key
ALLOWED_ORIGINS=https://vidsift.com
RESEND_API_KEY=your_resend_key
```

### 🚨 Security Steps Before Deployment:

1. **Remove .env from version control**:
```bash
echo ".env" >> .gitignore
git rm --cached .env
git commit -m "Remove .env from tracking"
```

2. **Generate a secure API key**:
```bash
# Replace the dev key with a secure one
openssl rand -hex 32
```

3. **Update ALLOWED_ORIGINS** for production domains only

## Deployment Instructions

### For Docker-based platforms (Railway, Render, etc.):
The Dockerfile is ready. Just connect your repo and deploy.

### For Node.js platforms (Heroku, Vercel, etc.):
1. Ensure Node.js version >= 18
2. Start command: `npm start`
3. Build command: none required

### For Sevalla:
1. Create a new Node.js application
2. Set Node version to 18+
3. Add all environment variables
4. Deploy from Git repository

## Post-Deployment:

1. **Test the health endpoint**:
```bash
curl https://your-backend-url.com/health
```

2. **Test channel processing**:
```bash
curl -X POST https://your-backend-url.com/api/channels/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-backend-api-key" \
  -H "x-user-id: test-user-id" \
  -H "x-user-email: test@example.com" \
  -d '{"channelId": "@someYoutubeChannel"}'
```

3. **Monitor logs** for cron job execution

## Database Requirements:
Ensure these tables exist in Supabase:
- channels
- videos
- transcript_chunks
- channel_queue
- users
- processing_locks (with locked_at column)

## Cron Jobs:
The backend runs automatic jobs every 5 minutes to process pending channels.