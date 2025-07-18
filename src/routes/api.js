import express from 'express';
import { channelProcessor } from '../services/channelProcessor.js';
import { videoProcessor } from '../services/videoProcessor.js';
import { chatService } from '../services/chatService.js';
import { queueService } from '../services/queueService.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { supabase } from '../server.js';

const router = express.Router();

// ===== CHANNEL ROUTES =====
router.post('/channels/process', authMiddleware, rateLimitMiddleware('channel_process'), async (req, res) => {
  try {
    const { channelId: channelUrl } = req.body;
    const clerkUserId = req.user?.id;
    const userEmail = req.user?.email;
    
    if (!channelUrl) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    
    console.log('🎯 Processing channel request:', { channelUrl, clerkUserId, userEmail });
    
    // Get the actual user from database using Clerk ID
    let dbUser = null;
    if (clerkUserId && clerkUserId !== 'api-client') {
      const { data: userData } = await supabase
        .from('users')
        .select('id')
        .eq('clerk_id', clerkUserId)
        .single();
      
      if (userData) {
        dbUser = userData;
      } else if (userEmail) {
        // Try to find by email if no clerk_id match
        const { data: userByEmail } = await supabase
          .from('users')
          .select('id')
          .eq('email', userEmail)
          .single();
        dbUser = userByEmail;
      }
    }
    
    const userId = dbUser?.id || null;
    
    // Extract channel ID from URL
    let channelId = channelUrl;
    if (channelUrl.includes('youtube.com')) {
      const match = channelUrl.match(/(?:\/channel\/|\/c\/|\/user\/|@)([a-zA-Z0-9_-]+)/);
      if (match) {
        channelId = match[1];
        // If it's a handle (@username), we need to resolve it to a channel ID
        if (channelUrl.includes('@')) {
          // For now, we'll use the handle as-is
          // In production, you'd use YouTube API to resolve handle to channel ID
          console.log('📌 Channel handle detected:', channelId);
        }
      }
    }
    
    // Create channel record first
    const channelData = {
      youtube_channel_id: channelId,
      title: `Channel ${channelId}`, // Will be updated when processing
      status: 'pending'
    };
    
    // Only add owner_user_id if we have a valid user ID
    if (userId) {
      channelData.owner_user_id = userId;
    }
    
    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .insert(channelData)
      .select()
      .single();
      
    if (channelError && !channelError.message.includes('duplicate')) {
      throw channelError;
    }
    
    // Get existing channel if insert failed due to duplicate
    let existingChannel = channel;
    if (!existingChannel) {
      const { data } = await supabase
        .from('channels')
        .select()
        .eq('youtube_channel_id', channelId)
        .single();
      existingChannel = data;
    }
    
    // Create queue entry
    const queueData = {
      channel_id: existingChannel.id,
      status: 'pending'
    };
    
    // Only add requested_by if we have a valid user ID
    if (userId) {
      queueData.requested_by = userId;
    }
    
    const { data: queueItem, error: queueError } = await supabase
      .from('channel_queue')
      .insert(queueData)
      .select()
      .single();
      
    if (queueError) {
      throw queueError;
    }
    
    // Start processing (don't wait for completion)
    channelProcessor.processChannel(queueItem.id).catch(err => {
      console.error('Channel processing error:', err);
    });
    
    res.json({ 
      success: true, 
      message: 'Channel processing started',
      channelId: existingChannel.youtube_channel_id,
      queueId: queueItem.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/channels/:channelId/status', async (req, res) => {
  try {
    const { channelId } = req.params;
    
    const { data: queueItem } = await supabase
      .from('channel_queue')
      .select(`
        id,
        status,
        total_videos,
        videos_processed,
        current_video_index,
        current_video_title,
        started_at,
        completed_at,
        error_message
      `)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    res.json({ success: true, queue: queueItem });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== VIDEO ROUTES =====
router.post('/videos/process', authMiddleware, rateLimitMiddleware('video_upload'), async (req, res) => {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }
    
    // Start processing (don't wait for completion)
    videoProcessor.processVideo(videoId).catch(err => {
      console.error('Video processing error:', err);
    });
    
    res.json({ 
      success: true, 
      message: 'Video processing started',
      videoId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/videos/:videoId/summary', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    // Check if summary exists
    const { data: video } = await supabase
      .from('videos')
      .select('id, summary')
      .eq('youtube_id', videoId)
      .single();
    
    if (video?.summary) {
      return res.json({ success: true, summary: video.summary });
    }
    
    // Generate summary
    const summary = await chatService.generateSummary(videoId);
    
    if (summary) {
      // Save summary
      await supabase
        .from('videos')
        .update({ summary })
        .eq('youtube_id', videoId);
    }
    
    res.json({ success: true, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CHAT ROUTES =====
router.post('/chat/stream', authMiddleware, rateLimitMiddleware('chat'), async (req, res) => {
  try {
    const { messages, videoId, sessionId } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable Nginx buffering
    });
    
    // Process chat with streaming
    await chatService.streamChat({ messages, videoId, sessionId }, res);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chat/channel/stream', authMiddleware, rateLimitMiddleware('chat'), async (req, res) => {
  try {
    const { messages, channelId, sessionId } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable Nginx buffering
    });
    
    // Process channel chat with streaming
    await chatService.streamChannelChat({ messages, channelId, sessionId }, res);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/chat/sessions', authMiddleware, async (req, res) => {
  try {
    const { userId, videoId, title } = req.body;
    
    // Create new chat session
    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({
        user_id: userId,
        video_id: videoId,
        title: title || 'New Chat',
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/chat/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);
    
    if (error) throw error;
    
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent chat sessions
router.get('/chat-sessions/recent', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10 } = req.query;
    
    const { data: sessions, error } = await supabase
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        last_activity,
        message_count,
        videos (
          id,
          title,
          youtube_id,
          thumbnail_url
        ),
        channels (
          id,
          title
        )
      `)
      .eq('user_id', userId)
      .order('last_activity', { ascending: false })
      .limit(limit);
    
    if (error) throw error;
    
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Basic chat endpoint (non-streaming)
router.post('/chat', authMiddleware, rateLimitMiddleware('chat'), async (req, res) => {
  try {
    const { message, videoId, channelId } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    
    // Use the chat service to get a response
    const messages = [{ role: 'user', content: message }];
    let response = '';
    
    // Create a mock response object to capture the stream
    const mockRes = {
      write: (data) => {
        const parsed = JSON.parse(data.replace('data: ', '').trim());
        if (parsed.type === 'content') {
          response += parsed.content;
        }
      },
      writeHead: () => {},
      end: () => {}
    };
    
    if (videoId) {
      await chatService.streamChat({ messages, videoId }, mockRes);
    } else if (channelId) {
      await chatService.streamChannelChat({ messages, channelId }, mockRes);
    } else {
      return res.status(400).json({ error: 'videoId or channelId required' });
    }
    
    res.json({ success: true, response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== MONITORING ROUTES =====
router.get('/monitor/stats', async (req, res) => {
  try {
    // Get queue stats
    const { data: queueStats } = await supabase
      .from('channel_queue')
      .select('status')
      .in('status', ['pending', 'processing', 'completed', 'failed']);
    
    const queueCounts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0
    };
    
    queueStats?.forEach(item => {
      if (item.status in queueCounts) queueCounts[item.status]++;
    });
    
    // Get video stats
    const { data: videoStats } = await supabase
      .from('videos')
      .select('transcript_cached, chunks_processed');
    
    const videoCounts = {
      total: videoStats?.length || 0,
      transcribed: videoStats?.filter(v => v.transcript_cached).length || 0,
      processed: videoStats?.filter(v => v.chunks_processed).length || 0
    };
    
    // Get recent activity
    const { data: recentChannels } = await supabase
      .from('channel_queue')
      .select(`
        id,
        status,
        total_videos,
        videos_processed,
        started_at,
        completed_at,
        channels (
          title,
          youtube_channel_id
        )
      `)
      .order('created_at', { ascending: false })
      .limit(10);
    
    res.json({ 
      success: true, 
      stats: {
        queue: queueCounts,
        videos: videoCounts,
        recentActivity: recentChannels
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/monitor/trigger-cron', authMiddleware, async (req, res) => {
  try {
    // Manually trigger channel processing
    channelProcessor.processPendingChannels().catch(err => {
      console.error('Manual cron trigger error:', err);
    });
    
    res.json({ 
      success: true, 
      message: 'Channel processing triggered manually' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== QUEUE ROUTES =====
router.post('/queue/channel', authMiddleware, async (req, res) => {
  try {
    const { channelId, priority = 'normal' } = req.body;
    const userId = req.user.id;
    
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    
    const result = await queueService.enqueueChannel(channelId, userId, priority);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/queue/video', authMiddleware, async (req, res) => {
  try {
    const { videoId, priority = 'normal' } = req.body;
    const userId = req.user.id;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }
    
    const result = await queueService.enqueueVideo(videoId, userId, priority);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/queue/status', async (req, res) => {
  try {
    const status = await queueService.getQueueStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/queue/position/:queueItemId', async (req, res) => {
  try {
    const { queueItemId } = req.params;
    const position = await queueService.getChannelQueuePosition(queueItemId);
    
    res.json({ 
      success: true, 
      position: position || 0,
      inQueue: position !== null 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/queue/process-videos', authMiddleware, async (req, res) => {
  try {
    const { limit = 5 } = req.body;
    const processed = await queueService.processVideoQueue(limit);
    
    res.json({ 
      success: true, 
      message: `Processing ${processed} videos`,
      processed 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ERROR TRACKING ROUTES =====
router.get('/errors/stats', authMiddleware, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const { errorTracker } = await import('../services/errorTracker.js');
    const stats = await errorTracker.getErrorStats(parseInt(hours));
    
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CRON STATUS ROUTES =====
router.get('/cron/status', async (req, res) => {
  try {
    const { data: recentJobs } = await supabase
      .from('cron_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20);
    
    // Get job statistics
    const { data: stats } = await supabase
      .from('cron_logs')
      .select('job_name, status')
      .gte('started_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    
    const jobStats = {};
    stats?.forEach(job => {
      if (!jobStats[job.job_name]) {
        jobStats[job.job_name] = { total: 0, completed: 0, failed: 0 };
      }
      jobStats[job.job_name].total++;
      if (job.status === 'completed') jobStats[job.job_name].completed++;
      if (job.status === 'failed') jobStats[job.job_name].failed++;
    });
    
    res.json({ 
      success: true, 
      recentJobs,
      stats: jobStats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;