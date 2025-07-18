import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { supabase } from '../server.js';
import { videoProcessor } from '../services/videoProcessor.js';

const router = express.Router();

// Helper function to parse YouTube duration
function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1]) || 0;
  const minutes = parseInt(match[2]) || 0;
  const seconds = parseInt(match[3]) || 0;
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Get video transcript
router.get('/transcript', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Get video with transcript chunks
    const { data: video, error } = await supabase
      .from('videos')
      .select(`
        id,
        youtube_id,
        title,
        transcript_cached,
        chunks_processed,
        transcript_chunks (
          id,
          chunk_index,
          text,
          start_time,
          end_time
        )
      `)
      .eq('youtube_id', videoId)
      .single();

    if (error || !video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!video.transcript_cached || !video.transcript_chunks || video.transcript_chunks.length === 0) {
      return res.status(404).json({ 
        error: 'Transcript not available',
        needsProcessing: true
      });
    }

    // Sort chunks by index
    const sortedChunks = video.transcript_chunks.sort((a, b) => a.chunk_index - b.chunk_index);
    
    // Combine chunks into full transcript
    const fullTranscript = sortedChunks
      .map(chunk => chunk.text)
      .join('\n');

    res.json({
      success: true,
      transcript: fullTranscript,
      chunks: sortedChunks,
      video: {
        id: video.id,
        youtube_id: video.youtube_id,
        title: video.title
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Quick transcript access (returns just the text)
router.get('/transcript-quick', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Get cached transcript if available
    const { data: video, error } = await supabase
      .from('videos')
      .select('id, transcript_text')
      .eq('youtube_id', videoId)
      .single();

    if (error || !video || !video.transcript_text) {
      // Try to get from chunks
      const { data: chunks, error: chunksError } = await supabase
        .from('transcript_chunks')
        .select('text')
        .eq('video_id', video?.id)
        .order('chunk_index');

      if (chunksError || !chunks || chunks.length === 0) {
        return res.status(404).json({ error: 'Transcript not available' });
      }

      const transcript = chunks.map(c => c.text).join('\n');
      
      // Cache the transcript for next time
      if (video?.id) {
        await supabase
          .from('videos')
          .update({ transcript_text: transcript })
          .eq('id', video.id);
      }

      return res.json({ success: true, transcript });
    }

    res.json({ success: true, transcript: video.transcript_text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process video (wrapper for frontend compatibility)
router.post('/process', authMiddleware, rateLimitMiddleware('video_process'), async (req, res) => {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Check if video already exists
    const { data: existingVideo } = await supabase
      .from('videos')
      .select('id, transcript_cached, chunks_processed')
      .eq('youtube_id', videoId)
      .single();

    if (existingVideo && existingVideo.transcript_cached) {
      return res.json({ 
        success: true,
        processing: false,
        alreadyProcessed: true 
      });
    }

    // Start processing
    videoProcessor.processVideo(videoId).catch(err => {
      console.error('Failed to process video:', err);
    });

    res.json({ 
      success: true,
      processing: true,
      message: 'Video processing started'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process video embeddings
router.post('/process-embeddings', authMiddleware, rateLimitMiddleware('video_process'), async (req, res) => {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Check if video exists and has transcript
    const { data: video, error } = await supabase
      .from('videos')
      .select('id, transcript_cached, chunks_processed')
      .eq('youtube_id', videoId)
      .single();

    if (error || !video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!video.transcript_cached) {
      return res.status(400).json({ 
        error: 'Video transcript must be processed first',
        needsTranscript: true 
      });
    }

    if (video.chunks_processed) {
      return res.json({ 
        success: true, 
        message: 'Embeddings already processed',
        alreadyProcessed: true 
      });
    }

    // Process embeddings asynchronously
    videoProcessor.processVideoEmbeddings(videoId).catch(err => {
      console.error('Failed to process embeddings:', err);
    });

    res.json({ 
      success: true, 
      message: 'Embedding processing started',
      videoId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if video needs indexing
router.get('/check', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Check if video exists and has transcript
    const { data: video, error } = await supabase
      .from('videos')
      .select('id, youtube_id, transcript_cached, chunks_processed')
      .eq('youtube_id', videoId)
      .single();

    if (error || !video) {
      return res.json({ 
        needsIndexing: true,
        exists: false
      });
    }

    // Check if video is fully processed
    const needsIndexing = !video.transcript_cached || !video.chunks_processed;

    res.json({ 
      needsIndexing,
      exists: true,
      hasTranscript: video.transcript_cached,
      hasChunks: video.chunks_processed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get video metadata
router.get('/metadata', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Get video metadata
    const { data: video, error } = await supabase
      .from('videos')
      .select(`
        id,
        youtube_id,
        title,
        description,
        thumbnail_url,
        duration,
        transcript_cached,
        chunks_processed,
        created_at,
        channel_id,
        channels (
          id,
          title,
          youtube_channel_id
        )
      `)
      .eq('youtube_id', videoId)
      .single();

    if (error || !video) {
      // Try to fetch from YouTube API
      const ytResponse = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
      );

      if (!ytResponse.ok) {
        throw new Error('Failed to fetch video from YouTube');
      }

      const ytData = await ytResponse.json();
      
      if (!ytData.items || ytData.items.length === 0) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const videoData = ytData.items[0];
      
      // Parse duration
      const duration = parseDuration(videoData.contentDetails.duration);

      return res.json({
        success: true,
        video: {
          youtube_id: videoId,
          title: videoData.snippet.title,
          description: videoData.snippet.description,
          thumbnail_url: videoData.snippet.thumbnails.maxres?.url || 
                        videoData.snippet.thumbnails.high?.url || 
                        videoData.snippet.thumbnails.medium?.url,
          duration,
          channel: {
            title: videoData.snippet.channelTitle,
            youtube_channel_id: videoData.snippet.channelId
          },
          fromYouTube: true
        }
      });
    }

    res.json({ success: true, video });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check video chunks status
router.get('/check-chunks', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    // Get video and chunk info
    const { data: video, error } = await supabase
      .from('videos')
      .select(`
        id,
        youtube_id,
        transcript_cached,
        chunks_processed
      `)
      .eq('youtube_id', videoId)
      .single();

    if (error || !video) {
      return res.status(404).json({ 
        error: 'Video not found',
        exists: false 
      });
    }

    // Get chunk count
    const { count: chunkCount } = await supabase
      .from('transcript_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('video_id', video.id);

    res.json({
      success: true,
      status: {
        videoId: video.youtube_id,
        transcriptCached: video.transcript_cached,
        chunksProcessed: video.chunks_processed,
        chunkCount: chunkCount || 0,
        ready: video.transcript_cached && video.chunks_processed && chunkCount > 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;