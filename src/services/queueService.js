import { supabase } from '../server.js';

class QueueService {
  constructor() {
    this.processingQueues = new Map();
  }

  async enqueueChannel(channelId, userId, priority = 'normal') {
    try {
      // Check if channel is already in queue
      const { data: existing } = await supabase
        .from('channel_queue')
        .select('id, status')
        .eq('channel_id', channelId)
        .in('status', ['pending', 'processing'])
        .single();

      if (existing) {
        return {
          success: false,
          message: 'Channel is already in queue',
          queueItem: existing
        };
      }

      // Get channel details
      const { data: channel } = await supabase
        .from('channels')
        .select('id, title, youtube_channel_id')
        .eq('id', channelId)
        .single();

      if (!channel) {
        throw new Error('Channel not found');
      }

      // Create queue item
      const { data: queueItem, error } = await supabase
        .from('channel_queue')
        .insert({
          channel_id: channelId,
          requested_by: userId,
          status: 'pending',
          priority: priority,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      return {
        success: true,
        message: 'Channel queued for processing',
        queueItem
      };
    } catch (error) {
      console.error('Error enqueueing channel:', error);
      throw error;
    }
  }

  async enqueueVideo(videoId, userId, priority = 'normal') {
    try {
      // Check if video exists
      const { data: video } = await supabase
        .from('videos')
        .select('id, title, youtube_id, transcript_cached')
        .eq('youtube_id', videoId)
        .single();

      if (video?.transcript_cached) {
        return {
          success: false,
          message: 'Video already processed',
          video
        };
      }

      // Create or update video record
      const { data: videoRecord, error: videoError } = await supabase
        .from('videos')
        .upsert({
          youtube_id: videoId,
          title: 'Processing...',
          transcript_cached: false,
          processing_queued: true,
          processing_queued_at: new Date().toISOString(),
          processing_queued_by: userId
        }, {
          onConflict: 'youtube_id'
        })
        .select()
        .single();

      if (videoError) throw videoError;

      // Trigger immediate processing if high priority
      if (priority === 'high') {
        this.triggerVideoProcessing(videoId);
      }

      return {
        success: true,
        message: 'Video queued for processing',
        video: videoRecord
      };
    } catch (error) {
      console.error('Error enqueueing video:', error);
      throw error;
    }
  }

  async getQueueStatus() {
    try {
      // Get queue statistics
      const { data: channelQueue } = await supabase
        .from('channel_queue')
        .select('status')
        .in('status', ['pending', 'processing']);

      const { data: processingVideos } = await supabase
        .from('videos')
        .select('youtube_id')
        .eq('processing_queued', true)
        .eq('transcript_cached', false);

      const stats = {
        channels: {
          pending: channelQueue?.filter(q => q.status === 'pending').length || 0,
          processing: channelQueue?.filter(q => q.status === 'processing').length || 0
        },
        videos: {
          queued: processingVideos?.length || 0
        }
      };

      return stats;
    } catch (error) {
      console.error('Error getting queue status:', error);
      throw error;
    }
  }

  async getChannelQueuePosition(queueItemId) {
    try {
      // Get all pending items ordered by creation
      const { data: pendingItems } = await supabase
        .from('channel_queue')
        .select('id')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (!pendingItems) return null;

      const position = pendingItems.findIndex(item => item.id === queueItemId) + 1;
      
      return position > 0 ? position : null;
    } catch (error) {
      console.error('Error getting queue position:', error);
      return null;
    }
  }

  async processVideoQueue(limit = 5) {
    try {
      // Get queued videos
      const { data: queuedVideos } = await supabase
        .from('videos')
        .select('youtube_id')
        .eq('processing_queued', true)
        .eq('transcript_cached', false)
        .order('processing_queued_at', { ascending: true })
        .limit(limit);

      if (!queuedVideos || queuedVideos.length === 0) {
        return 0;
      }

      let processedCount = 0;

      // Process each video
      for (const video of queuedVideos) {
        try {
          await this.triggerVideoProcessing(video.youtube_id);
          processedCount++;
        } catch (error) {
          console.error(`Failed to process video ${video.youtube_id}:`, error);
        }
      }

      return processedCount;
    } catch (error) {
      console.error('Error processing video queue:', error);
      return 0;
    }
  }

  async triggerVideoProcessing(videoId) {
    // Import dynamically to avoid circular dependency
    const { videoProcessor } = await import('./videoProcessor.js');
    
    // Process in background
    videoProcessor.processVideo(videoId).catch(err => {
      console.error(`Video processing failed for ${videoId}:`, err);
    });
  }

  async triggerChannelProcessing(queueItemId) {
    // Import dynamically to avoid circular dependency
    const { channelProcessor } = await import('./channelProcessor.js');
    
    // Process in background
    channelProcessor.processChannel(queueItemId).catch(err => {
      console.error(`Channel processing failed for ${queueItemId}:`, err);
    });
  }

  async retryFailedItems() {
    try {
      // Retry failed channels
      const { data: failedChannels } = await supabase
        .from('channel_queue')
        .select('id')
        .eq('status', 'failed')
        .lt('retry_count', 3)
        .limit(5);

      if (failedChannels) {
        for (const item of failedChannels) {
          await supabase
            .from('channel_queue')
            .update({
              status: 'pending',
              retry_count: supabase.sql`retry_count + 1`,
              error_message: null
            })
            .eq('id', item.id);
        }
      }

      return failedChannels?.length || 0;
    } catch (error) {
      console.error('Error retrying failed items:', error);
      return 0;
    }
  }

  async cleanupOldQueue() {
    try {
      // Remove completed items older than 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from('channel_queue')
        .delete()
        .eq('status', 'completed')
        .lt('completed_at', sevenDaysAgo);

      if (error) {
        console.error('Error cleaning up old queue items:', error);
      }
    } catch (error) {
      console.error('Error in queue cleanup:', error);
    }
  }
}

export const queueService = new QueueService();

// Process video queue periodically
setInterval(() => {
  queueService.processVideoQueue().catch(err => {
    console.error('Video queue processing error:', err);
  });
}, 30000); // Every 30 seconds

// Retry failed items periodically
setInterval(() => {
  queueService.retryFailedItems().catch(err => {
    console.error('Failed items retry error:', err);
  });
}, 300000); // Every 5 minutes

// Cleanup old queue items daily
setInterval(() => {
  queueService.cleanupOldQueue().catch(err => {
    console.error('Queue cleanup error:', err);
  });
}, 86400000); // Every 24 hours