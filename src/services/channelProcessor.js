import { supabase } from '../server.js';
import { videoProcessor } from './videoProcessor.js';
import { emailService } from './emailService.js';
import { lockService } from './lockService.js';

class ChannelProcessor {
  constructor() {
    this.processingChannels = new Set();
  }

  async processPendingChannels() {
    try {
      // Get pending channels
      const { data: pendingChannels, error } = await supabase
        .from('channel_queue')
        .select(`
          *,
          channels (
            id,
            youtube_channel_id,
            title,
            owner_user_id
          ),
          users!channel_queue_requested_by_fkey (
            id,
            email,
            clerk_id
          )
        `)
        .eq('status', 'pending')
        .limit(5);

      if (error) {
        console.error('Error fetching pending channels:', error);
        return;
      }

      if (!pendingChannels || pendingChannels.length === 0) {
        // Don't log when there's nothing to process
        return;
      }

      console.log(`📋 Found ${pendingChannels.length} channels to process`);

      // Process each channel
      for (const queueItem of pendingChannels) {
        if (!queueItem.channels) {
          await this.markChannelFailed(queueItem.id, 'Channel not found');
          continue;
        }

        await this.processChannel(queueItem.id);
      }
    } catch (error) {
      console.error('Error in processPendingChannels:', error);
    }
  }

  async processChannel(queueItemId) {
    // Try to acquire distributed lock
    const lockId = await lockService.acquire(`channel-queue-${queueItemId}`, 3600); // 1 hour lock
    if (!lockId) {
      console.log(`⏭️ Channel queue item ${queueItemId} is already being processed`);
      return;
    }

    try {
      // Get queue item details with user info
      const { data: queueItem, error: queueError } = await supabase
        .from('channel_queue')
        .select(`
          *,
          channels (
            id,
            youtube_channel_id,
            title
          ),
          users!channel_queue_requested_by_fkey (
            id,
            email,
            clerk_id
          )
        `)
        .eq('id', queueItemId)
        .single();

      if (queueError || !queueItem || !queueItem.channels) {
        throw new Error('Queue item or channel not found');
      }

      const channel = queueItem.channels;
      console.log(`🚀 Processing channel: ${channel.title}`);

      // Mark as processing
      await supabase
        .from('channel_queue')
        .update({ 
          status: 'processing', 
          started_at: new Date().toISOString() 
        })
        .eq('id', queueItemId);

      await supabase
        .from('channels')
        .update({ status: 'processing' })
        .eq('id', channel.id);

      // Fetch videos from YouTube API
      const videos = await this.fetchChannelVideos(channel.youtube_channel_id);
      console.log(`📺 Found ${videos.length} videos in channel`);

      // Update counts
      await supabase
        .from('channel_queue')
        .update({ 
          total_videos: videos.length,
          estimated_completion_at: new Date(Date.now() + (videos.length * 30000)).toISOString()
        })
        .eq('id', queueItemId);

      // Process videos - TRACK STATISTICS LIKE FRONTEND
      let processedCount = 0;
      let failedCount = 0;
      let existingCount = 0;
      let noTranscriptCount = 0;

      // Process up to 20 videos
      const videosToProcess = videos.slice(0, 20);
      console.log(`📹 Processing ${videosToProcess.length} videos from channel`);

      for (let i = 0; i < videosToProcess.length; i++) {
        const video = videosToProcess[i];
        
        try {
          // Update progress
          await supabase
            .from('channel_queue')
            .update({
              current_video_index: i + 1,
              current_video_title: video.snippet.title,
              videos_processed: processedCount
            })
            .eq('id', queueItemId);

          // Check if video exists
          const { data: existingVideo } = await supabase
            .from('videos')
            .select('id, transcript_cached')
            .eq('youtube_id', video.id.videoId)
            .single();

          if (existingVideo && existingVideo.transcript_cached) {
            console.log(`⏭️ Video already processed: ${video.snippet.title}`);
            processedCount++;
            existingCount++;
            continue;
          }

          // Create or update video record
          const { error: videoError } = await supabase
            .from('videos')
            .upsert({
              youtube_id: video.id.videoId,
              title: video.snippet.title,
              description: video.snippet.description || '',
              thumbnail_url: video.snippet.thumbnails?.medium?.url || '',
              channel_id: channel.id,
              transcript_cached: false,
              duration: 0 // Will be updated when transcript is processed
            }, {
              onConflict: 'youtube_id'
            });

          if (videoError) {
            console.error(`Failed to create video record:`, videoError);
            failedCount++;
            continue;
          }

          // Process video transcript
          const processed = await videoProcessor.processVideoTranscript(video.id.videoId);
          
          if (processed) {
            processedCount++;
          } else {
            failedCount++;
            // Check if it's a no transcript error
            const { data: updatedVideo } = await supabase
              .from('videos')
              .select('processing_error')
              .eq('youtube_id', video.id.videoId)
              .single();
            
            if (updatedVideo?.processing_error?.includes('transcript') || 
                updatedVideo?.processing_error?.includes('captions')) {
              noTranscriptCount++;
            }
          }

          // Add delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          console.error(`Error processing video ${video.snippet.title}:`, error);
          failedCount++;
        }
      }

      // Mark channel as completed
      await supabase
        .from('channel_queue')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          videos_processed: processedCount,
          error_message: null
        })
        .eq('id', queueItemId);

      await supabase
        .from('channels')
        .update({ 
          status: 'ready', // Use 'ready' instead of 'completed'
          video_count: processedCount
        })
        .eq('id', channel.id);

      console.log(`✅ Channel processing completed: ${processedCount} videos processed, ${failedCount} failed`);
      console.log('📧 Queue item user info:', queueItem.users);

      // Send completion email with detailed statistics
      // Use videosToProcess.length instead of videos.length since we're only processing 2
      await this.sendCompletionEmail(queueItem, processedCount, videosToProcess.length, existingCount, noTranscriptCount, failedCount);

    } catch (error) {
      console.error(`Error processing channel:`, error);
      await this.markChannelFailed(queueItemId, error.message);
    } finally {
      // Release the lock
      await lockService.release(`channel-queue-${queueItemId}`);
    }
  }

  async resolveChannelHandle(handle) {
    // First, try to search for the channel by handle
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.append('part', 'snippet');
    searchUrl.searchParams.append('q', handle);
    searchUrl.searchParams.append('type', 'channel');
    searchUrl.searchParams.append('maxResults', '1');
    searchUrl.searchParams.append('key', process.env.YOUTUBE_API_KEY);

    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      throw new Error(`YouTube API error during channel search: ${searchResponse.statusText}`);
    }

    const searchData = await searchResponse.json();
    
    if (searchData.items && searchData.items.length > 0) {
      const channel = searchData.items[0];
      console.log(`✅ Resolved handle @${handle} to channel ID: ${channel.id.channelId}`);
      return {
        channelId: channel.id.channelId,
        title: channel.snippet.title
      };
    }
    
    throw new Error(`Could not find channel with handle: @${handle}`);
  }

  async fetchChannelVideos(channelId) {
    // If channelId starts with @ or contains only alphanumeric chars (likely a handle)
    let actualChannelId = channelId;
    let channelTitle = null;
    
    if (channelId.startsWith('@') || (!channelId.startsWith('UC') && channelId.match(/^[a-zA-Z0-9_-]+$/))) {
      console.log(`🔍 Resolving channel handle: ${channelId}`);
      const resolved = await this.resolveChannelHandle(channelId.replace('@', ''));
      actualChannelId = resolved.channelId;
      channelTitle = resolved.title;
      
      // Update the channel title in the database
      if (channelTitle) {
        await supabase
          .from('channels')
          .update({ 
            title: channelTitle,
            youtube_channel_id: actualChannelId 
          })
          .eq('youtube_channel_id', channelId);
      }
    }
    
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.append('part', 'snippet');
    url.searchParams.append('channelId', actualChannelId);
    url.searchParams.append('type', 'video');
    url.searchParams.append('maxResults', '20'); // Limit to 20 videos
    url.searchParams.append('order', 'date');
    url.searchParams.append('key', process.env.YOUTUBE_API_KEY);

    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.statusText}`);
    }

    const data = await response.json();
    const videos = data.items || [];
    
    console.log(`🎯 Found ${videos.length} videos for channel ${channelTitle || actualChannelId}`);
    return videos;
  }

  async markChannelFailed(queueItemId, errorMessage) {
    await supabase
      .from('channel_queue')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: errorMessage
      })
      .eq('id', queueItemId);
  }

  async sendCompletionEmail(queueItem, videosProcessed, totalVideos, existingVideos, noTranscriptVideos, failedVideos) {
    if (!queueItem.users?.email) {
      console.log('📧 No user email found for completion notification');
      return;
    }

    const channelTitle = queueItem.channels?.title || 'Unknown Channel';
    // Use the new method that matches frontend exactly
    await emailService.sendChannelProcessingNotification({
      userEmail: queueItem.users.email,
      userName: emailService.extractUserNameFromEmail(queueItem.users.email),
      channelTitle: channelTitle,
      channelUrl: `https://youtube.com/channel/${queueItem.channels.youtube_channel_id}`,
      videosProcessed: videosProcessed,
      totalVideos: totalVideos,
      existingVideos: existingVideos,
      noTranscriptVideos: noTranscriptVideos,
      failedVideos: failedVideos,
      status: 'completed'
    }).catch(err => console.error('Failed to send email:', err));
  }
}

export const channelProcessor = new ChannelProcessor();