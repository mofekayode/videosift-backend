# Frontend Integration Guide

This guide explains how to update your Next.js frontend to use the new backend service.

## 1. Environment Configuration

Add these to your `.env.local` and `.env.production`:

```bash
# Backend API Configuration
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000  # Development
# NEXT_PUBLIC_BACKEND_URL=https://api.vidsift.com  # Production
BACKEND_API_KEY=your-secure-api-key-here
```

## 2. Create Backend API Client

Create a new file `lib/backend-api.ts`:

```typescript
// lib/backend-api.ts

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
const API_KEY = process.env.BACKEND_API_KEY;

if (!API_KEY) {
  console.warn('BACKEND_API_KEY not configured');
}

interface BackendResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Helper for API calls
async function backendFetch<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<BackendResponse<T>> {
  const url = `${BACKEND_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': API_KEY || '',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Backend API error (${endpoint}):`, error);
    throw error;
  }
}

// Channel Processing
export async function processChannel(channelId: string) {
  return backendFetch('/api/channels/process', {
    method: 'POST',
    body: JSON.stringify({ channelId }),
  });
}

export async function getChannelStatus(channelId: string) {
  return backendFetch(`/api/channels/${channelId}/status`);
}

// Video Processing
export async function processVideo(videoId: string) {
  return backendFetch('/api/videos/process', {
    method: 'POST',
    body: JSON.stringify({ videoId }),
  });
}

export async function getVideoSummary(videoId: string) {
  return backendFetch(`/api/videos/${videoId}/summary`);
}

// Chat Sessions
export async function createChatSession(userId: string, videoId: string, title: string) {
  return backendFetch('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ userId, videoId, title }),
  });
}

export async function getChatHistory(sessionId: string, limit = 50, offset = 0) {
  return backendFetch(`/api/chat/sessions/${sessionId}/messages?limit=${limit}&offset=${offset}`);
}

// Monitoring
export async function getMonitorStats() {
  return backendFetch('/api/monitor/stats');
}

export async function triggerManualProcessing() {
  return backendFetch('/api/monitor/trigger-cron', {
    method: 'POST',
  });
}

// Chat Streaming
export async function* streamChat(
  messages: any[],
  videoId?: string,
  sessionId?: string
) {
  const response = await fetch(`${BACKEND_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY || '',
    },
    body: JSON.stringify({ messages, videoId, sessionId }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          yield data;
        } catch (e) {
          console.error('Failed to parse SSE data:', e);
        }
      }
    }
  }
}
```

## 3. Update Channel Processing

Replace your existing channel processing logic:

```typescript
// app/api/process-channel/route.ts or wherever you handle channel processing

import { processChannel } from '@/lib/backend-api';

export async function POST(request: Request) {
  try {
    const { channelId } = await request.json();
    
    // Call backend instead of processing locally
    const result = await processChannel(channelId);
    
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
```

## 4. Update Chat Component

Update your chat component to use the streaming API:

```typescript
// components/VideoChat.tsx or similar

import { streamChat } from '@/lib/backend-api';

async function handleSendMessage(message: string) {
  try {
    setIsLoading(true);
    const newMessages = [...messages, { role: 'user', content: message }];
    setMessages(newMessages);

    let assistantMessage = '';
    const stream = streamChat(newMessages, videoId, sessionId);

    for await (const chunk of stream) {
      if (chunk.type === 'content') {
        assistantMessage += chunk.content;
        // Update UI with streaming content
        setMessages([
          ...newMessages,
          { role: 'assistant', content: assistantMessage }
        ]);
      } else if (chunk.type === 'done') {
        // Handle citations
        if (chunk.citations?.length > 0) {
          handleCitations(chunk.citations);
        }
      } else if (chunk.type === 'error') {
        console.error('Chat error:', chunk.error);
        toast.error('Failed to get response');
      }
    }
  } catch (error) {
    console.error('Chat error:', error);
    toast.error('Failed to send message');
  } finally {
    setIsLoading(false);
  }
}
```

## 5. Update Monitor Page

Update your monitor page to use the backend stats:

```typescript
// app/monitor/page.tsx

import { getMonitorStats, triggerManualProcessing } from '@/lib/backend-api';

export default function MonitorPage() {
  const [stats, setStats] = useState(null);
  
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const result = await getMonitorStats();
        setStats(result.stats);
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // Refresh every 5 seconds
    
    return () => clearInterval(interval);
  }, []);

  const handleManualTrigger = async () => {
    try {
      await triggerManualProcessing();
      toast.success('Processing triggered');
    } catch (error) {
      toast.error('Failed to trigger processing');
    }
  };

  // ... rest of component
}
```

## 6. Remove Old Code

Once the backend is working, you can remove:

1. `/app/api/cron/process-channels` - No longer needed
2. `/app/api/process-channel` - Replaced by backend
3. `/lib/channel-processor.ts` - Moved to backend
4. `/lib/distributed-lock.ts` - Moved to backend
5. Any video processing logic in the frontend

## 7. Update Vercel Configuration

Remove the cron job from `vercel.json` since it's now handled by the backend:

```json
{
  // Remove the crons section entirely
}
```

## 8. Testing the Integration

1. Start the backend locally:
   ```bash
   cd backend
   npm install
   npm run dev
   ```

2. Start the frontend with updated environment variables:
   ```bash
   cd ..
   npm run dev
   ```

3. Test channel processing:
   - Add a new channel through the UI
   - Check the backend logs for processing activity
   - Monitor the database for updates

4. Test chat functionality:
   - Open a video chat
   - Send messages and verify streaming works
   - Check that citations are handled correctly

## Common Issues

1. **CORS Errors**
   - Ensure your frontend URL is in ALLOWED_ORIGINS in backend
   - Check both with and without www

2. **401 Unauthorized**
   - Verify BACKEND_API_KEY matches in both frontend and backend
   - Check the X-API-KEY header is being sent

3. **Connection Refused**
   - Ensure backend is running on the correct port
   - Check NEXT_PUBLIC_BACKEND_URL is correct

4. **Timeout Errors**
   - The backend is designed for long-running tasks
   - Frontend should show loading states appropriately