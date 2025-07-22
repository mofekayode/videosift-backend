import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { supabase } from '../server.js';

const router = express.Router();

// Get user's channels
router.get('/channels', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get channels accessible to the user through user_channels table
    const { data: userChannelRelations, error: relError } = await supabase
      .from('user_channels')
      .select('channel_id')
      .eq('user_id', userId);
    
    if (relError) throw relError;
    
    if (!userChannelRelations || userChannelRelations.length === 0) {
      return res.json({ success: true, channels: [] });
    }
    
    const channelIds = userChannelRelations.map(rel => rel.channel_id);
    
    const { data: channels, error } = await supabase
      .from('channels')
      .select(`
        id,
        youtube_channel_id,
        title,
        description,
        thumbnail_url,
        status,
        video_count,
        created_at,
        last_indexed_at
      `)
      .in('id', channelIds)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get processing status for each channel
    // channelIds already declared above, no need to redeclare
    const { data: queueItems } = await supabase
      .from('channel_queue')
      .select('channel_id, status, videos_processed, total_videos')
      .in('channel_id', channelIds)
      .eq('requested_by', userId);

    // Merge queue status with channels
    const channelsWithStatus = channels.map(channel => {
      const queueItem = queueItems?.find(q => q.channel_id === channel.id);
      return {
        ...channel,
        processing_status: queueItem?.status,
        videos_processed: queueItem?.videos_processed,
        total_videos: queueItem?.total_videos
      };
    });

    res.json({ success: true, channels: channelsWithStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's chat history
router.get('/chat-history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    const { data: sessions, error } = await supabase
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        last_activity,
        videos (
          id,
          title,
          youtube_id,
          thumbnail_url
        ),
        channels (
          id,
          title,
          youtube_channel_id
        )
      `)
      .eq('user_id', userId)
      .order('last_activity', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's message count
router.get('/message-count', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = 'day' } = req.query;

    // Calculate time window
    const now = new Date();
    let startTime;
    
    switch (period) {
      case 'hour':
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case 'day':
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    // Get message count
    const { count, error } = await supabase
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', startTime.toISOString());

    if (error) throw error;

    res.json({ 
      success: true, 
      count: count || 0,
      period,
      startTime: startTime.toISOString(),
      endTime: now.toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's recent activity
router.get('/recent-activity', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20 } = req.query;

    // Get recent chat sessions
    const { data: recentSessions, error: sessionsError } = await supabase
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        last_activity,
        videos (
          title,
          youtube_id
        ),
        channels (
          title
        )
      `)
      .eq('user_id', userId)
      .order('last_activity', { ascending: false })
      .limit(5);

    if (sessionsError) throw sessionsError;

    // Get recent channel processing
    const { data: recentChannels, error: channelsError } = await supabase
      .from('channel_queue')
      .select(`
        id,
        status,
        created_at,
        completed_at,
        channels (
          title,
          youtube_channel_id
        )
      `)
      .eq('requested_by', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (channelsError) throw channelsError;

    // Combine and sort activities
    const activities = [
      ...recentSessions.map(s => ({
        type: 'chat',
        id: s.id,
        title: s.title,
        timestamp: s.last_activity,
        metadata: {
          video: s.videos?.title,
          channel: s.channels?.title
        }
      })),
      ...recentChannels.map(c => ({
        type: 'channel_process',
        id: c.id,
        title: `Processing ${c.channels?.title || 'channel'}`,
        timestamp: c.completed_at || c.created_at,
        status: c.status,
        metadata: {
          channel: c.channels?.title
        }
      }))
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

    res.json({ success: true, activities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's usage statistics
router.get('/usage-stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get channel count from user_channels table
    const { count: channelCount } = await supabase
      .from('user_channels')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get total message count
    const { count: totalMessages } = await supabase
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get session count
    const { count: sessionCount } = await supabase
      .from('chat_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get messages in last 24 hours
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count: dailyMessages } = await supabase
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', dayAgo.toISOString());

    // Get messages in last hour
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { count: hourlyMessages } = await supabase
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', hourAgo.toISOString());

    res.json({
      success: true,
      stats: {
        channels: channelCount || 0,
        totalMessages: totalMessages || 0,
        sessions: sessionCount || 0,
        dailyMessages: dailyMessages || 0,
        hourlyMessages: hourlyMessages || 0,
        limits: {
          hourly: 30,
          daily: 100,
          channels: 1
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync user data
router.post('/sync', authMiddleware, async (req, res) => {
  try {
    const { clerkId, email, firstName, lastName } = req.user;
    
    // Check if user exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_id', clerkId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      throw checkError;
    }

    let user;
    
    if (existingUser) {
      // Update existing user
      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({
          email,
          first_name: firstName,
          last_name: lastName,
          updated_at: new Date().toISOString()
        })
        .eq('clerk_id', clerkId)
        .select()
        .single();

      if (updateError) throw updateError;
      user = updatedUser;
    } else {
      // Create new user
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          clerk_id: clerkId,
          email,
          first_name: firstName,
          last_name: lastName,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError) throw createError;
      user = newUser;
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a channel
router.delete('/channels/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const channelId = req.params.id;

    // Verify user has access to this channel
    const { data: userChannelRelation, error: checkError } = await supabase
      .from('user_channels')
      .select('id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .single();

    if (checkError || !userChannelRelation) {
      return res.status(404).json({ error: 'Channel not found or no access' });
    }

    // Remove user's access to the channel (don't delete the channel itself)
    const { error: deleteError } = await supabase
      .from('user_channels')
      .delete()
      .eq('user_id', userId)
      .eq('channel_id', channelId);

    if (deleteError) throw deleteError;

    // Check if any other users still have access to this channel
    const { count } = await supabase
      .from('user_channels')
      .select('*', { count: 'exact', head: true })
      .eq('channel_id', channelId);

    // If no other users have access, optionally mark channel as orphaned
    // For now, we'll leave channels even if no users have access
    // This allows re-indexing without losing data

    res.json({ success: true, message: 'Channel removed from your list successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Migrate sessions from anonymous to authenticated user
router.post('/migrate-sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { anonId } = req.body;

    if (!anonId) {
      return res.status(400).json({ error: 'Anonymous ID required' });
    }

    // Update all sessions from anonymous to authenticated user
    const { data: sessions, error } = await supabase
      .from('chat_sessions')
      .update({ 
        user_id: userId,
        anon_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('anon_id', anonId)
      .is('user_id', null)
      .select();

    if (error) throw error;

    res.json({ 
      success: true, 
      migratedCount: sessions?.length || 0,
      sessions 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;