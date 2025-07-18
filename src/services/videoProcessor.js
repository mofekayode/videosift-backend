import { supabase } from '../server.js';
import YoutubeTranscriptApi from 'youtube-transcript-api';
import OpenAI from 'openai';
import { lockService } from './lockService.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

class VideoProcessor {
  constructor() {
    this.processingVideos = new Set();
  }

  async processVideo(videoId) {
    // Try to acquire distributed lock
    const lockId = await lockService.acquire(`video-${videoId}`, 600); // 10 minute lock
    if (!lockId) {
      console.log(`⏭️ Video ${videoId} is already being processed`);
      return false;
    }

    try {
      console.log(`📥 Processing video: ${videoId}`);

      // Get transcript
      const transcript = await this.downloadTranscript(videoId);
      if (!transcript || transcript.length === 0) {
        throw new Error('No transcript available');
      }

      // Store transcript in Supabase storage
      console.log(`🔄 Step 1/4: Storing transcript...`);
      const transcriptPath = await this.storeTranscript(videoId, transcript);

      // Create embeddings for chunks
      console.log(`🔄 Step 2/4: Creating chunks...`);
      const chunks = this.createChunks(transcript);
      
      console.log(`🔄 Step 3/4: Generating embeddings...`);
      const chunksWithEmbeddings = await this.generateEmbeddings(chunks);

      // Store chunks in database
      console.log(`🔄 Step 4/4: Storing chunks in database...`);
      await this.storeChunks(videoId, chunksWithEmbeddings, transcriptPath);

      // Update video record
      await supabase
        .from('videos')
        .update({
          transcript_cached: true,
          chunks_processed: true,
          transcript_storage_path: transcriptPath
        })
        .eq('youtube_id', videoId);

      console.log(`✅ Video processed successfully: ${videoId}`);
      return true;

    } catch (error) {
      console.error(`❌ Error processing video ${videoId}:`, error);
      
      // Update video with error
      await supabase
        .from('videos')
        .update({
          transcript_cached: false,
          processing_error: error.message
        })
        .eq('youtube_id', videoId);

      return false;
    } finally {
      // Release the lock
      await lockService.release(`video-${videoId}`);
    }
  }

  async processVideoTranscript(videoId) {
    return this.processVideo(videoId);
  }

  async downloadWithRetry(videoId, retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await YoutubeTranscriptApi.getTranscript(videoId);
      } catch (error) {
        if ((error.status === 429 || error.message?.includes('429')) && i < retries - 1) {
          console.log(`⏳ Rate limited, waiting ${delay}ms before retry ${i + 1}/${retries}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        } else {
          throw error;
        }
      }
    }
  }

  async downloadTranscript(videoId) {
    try {
      console.log(`📥 Downloading transcript for: ${videoId}`);
      
      // Get the transcript with retry logic for rate limits
      const transcript = await this.downloadWithRetry(videoId);
      console.log('✅ Raw transcript received:', transcript ? `${transcript.length} segments` : 'null/undefined');
      
      if (!transcript || transcript.length === 0) {
        throw new Error('Unable to analyze this video. The video may not have captions enabled or may be private.');
      }
      
      // Convert to our format (matching frontend structure)
      const segments = transcript.map(segment => {
        const startTime = typeof segment.start === 'string' ? parseFloat(segment.start) : segment.start;
        const duration = typeof segment.duration === 'string' ? parseFloat(segment.duration) : segment.duration;
        
        return {
          start: Math.floor(startTime),
          end: Math.floor(startTime + duration),
          text: segment.text.trim()
        };
      });
      
      console.log(`✅ Converted ${segments.length} transcript segments`);
      return segments;
      
    } catch (error) {
      console.error('Transcript download error:', error);
      
      // Provide more specific error messages
      if (error.message?.includes('Could not get transcript')) {
        throw new Error('This video cannot be analyzed. Only videos with captions enabled can be processed.');
      } else if (error.message?.includes('Video unavailable')) {
        throw new Error('This video is unavailable. It may be private, deleted, or restricted in your region.');
      } else if (error.message?.includes('fetch failed') || error.message?.includes('ENOTFOUND')) {
        throw new Error('Network error while downloading transcript. Please check your internet connection.');
      } else if (error.message?.includes('Too Many Requests') || error.status === 429 || error.code === 'ERR_BAD_REQUEST') {
        throw new Error('YouTube is temporarily blocking requests due to rate limiting. Please wait a few minutes and try again.');
      }
      
      throw error;
    }
  }

  createChunks(transcript, chunkSize = 1000) {  // Match frontend's 1000 char chunks
    console.log(`🔪 Creating chunks from ${transcript.length} segments...`);
    const chunks = [];
    let byteOffset = 0;
    let chunkIndex = 0;
    let currentChunk = '';
    let chunkStartTime = 0;
    let chunkEndTime = 0;
    let chunkStartOffset = 0;

    for (let i = 0; i < transcript.length; i++) {
      const segment = transcript[i];
      const timestamp = this.formatTimestamp(segment.start);
      const line = `[${timestamp}] ${segment.text}\n`;
      
      // Start new chunk if needed
      if (currentChunk.length === 0) {
        chunkStartTime = segment.start;
        chunkStartOffset = byteOffset;
      }
      
      currentChunk += line;
      chunkEndTime = segment.end;
      
      // Check if we should end this chunk (matching frontend logic)
      const isNaturalBreak = segment.text.match(/[.!?]$/);
      const isLongEnough = currentChunk.length >= chunkSize;
      const isTooLong = currentChunk.length >= 2000;  // Max 2000 chars
      const isLastSegment = i === transcript.length - 1;
      
      if ((isNaturalBreak && isLongEnough) || isTooLong || isLastSegment) {
        // Save chunk metadata
        const chunkBytes = Buffer.from(currentChunk, 'utf-8');
        chunks.push({
          chunk_index: chunkIndex,
          start_time: chunkStartTime,
          end_time: chunkEndTime,
          byte_offset: chunkStartOffset,
          byte_length: chunkBytes.length,
          text: currentChunk,  // Keep text for embedding generation
          keywords: this.extractKeywords(currentChunk)
        });
        
        byteOffset += chunkBytes.length;
        chunkIndex++;
        currentChunk = '';
      }
    }
    
    console.log(`✅ Created ${chunks.length} chunks`);
    return chunks;
  }

  formatTimestamp(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  extractKeywords(text) {
    // COPIED EXACTLY FROM FRONTEND
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been'
    ]);
    
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));
    
    // Get unique keywords
    const wordSet = new Set(words);
    return Array.from(wordSet).slice(0, 10);
  }

  async generateEmbeddings(chunks) {
    console.log(`🧠 Generating embeddings for ${chunks.length} chunks...`);
    const chunksWithEmbeddings = [];
    
    // Process in batches to avoid rate limits
    const batchSize = 10;
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      const embeddings = await Promise.all(
        batch.map(async (chunk) => {
          try {
            const response = await openai.embeddings.create({
              model: "text-embedding-ada-002",
              input: chunk.text,
            });
            
            return {
              ...chunk,
              embedding: response.data[0].embedding
            };
          } catch (error) {
            console.error('Error generating embedding:', error);
            return {
              ...chunk,
              embedding: null
            };
          }
        })
      );
      
      chunksWithEmbeddings.push(...embeddings);
      console.log(`✅ Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(chunks.length/batchSize)}`);
      
      // Rate limit delay
      if (i + batchSize < chunks.length) {
        console.log(`⏳ Rate limit delay...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`✅ Generated embeddings for all ${chunksWithEmbeddings.length} chunks`);
    return chunksWithEmbeddings;
  }

  async storeTranscript(videoId, transcript) {
    console.log(`💾 Storing transcript for video ${videoId}...`);
    
    // Format transcript exactly like frontend
    let content = '';
    for (const segment of transcript) {
      const timestamp = this.formatTimestamp(segment.start);
      const line = `[${timestamp}] ${segment.text}\n`;
      content += line;
    }
    
    // Use same path format as frontend
    const path = `${videoId}/transcript.txt`;
    
    console.log(`📤 Uploading transcript file: ${path} (${content.length} bytes)`);
    const { data, error } = await supabase.storage
      .from('transcripts')
      .upload(path, content, {
        contentType: 'text/plain',
        upsert: true
      });
    
    if (error) {
      console.error(`❌ Storage upload error:`, error);
      
      // If bucket doesn't exist, try to create it (matching frontend)
      if (error.message?.includes('Bucket not found')) {
        console.log('Creating transcripts bucket...');
        const { error: createError } = await supabase.storage.createBucket('transcripts', {
          public: false,
          fileSizeLimit: 10485760, // 10MB
          allowedMimeTypes: ['text/plain']
        });
        
        if (!createError) {
          // Retry upload after creating bucket
          const { error: retryError } = await supabase.storage
            .from('transcripts')
            .upload(path, content, {
              contentType: 'text/plain',
              upsert: true
            });
          
          if (!retryError) {
            console.log(`✅ Transcript stored successfully at: ${path}`);
            return path;
          }
        }
      }
      
      throw new Error(`Failed to store transcript: ${error.message}`);
    }
    
    console.log(`✅ Transcript stored successfully at: ${path}`);
    return path;
  }

  async storeChunks(videoId, chunks, transcriptPath) {
    // Delete existing chunks
    await supabase
      .from('transcript_chunks')
      .delete()
      .eq('video_id', videoId);
    
    // Get video record
    const { data: video } = await supabase
      .from('videos')
      .select('id')
      .eq('youtube_id', videoId)
      .single();
    
    if (!video) {
      throw new Error('Video not found');
    }
    
    // Insert new chunks (matching frontend schema)
    console.log(`💾 Preparing ${chunks.length} chunks for database storage...`);
    const chunkRecords = chunks.map(chunk => ({
      video_id: video.id,
      chunk_index: chunk.chunk_index,
      start_time: chunk.start_time,
      end_time: chunk.end_time,
      storage_path: transcriptPath,
      byte_offset: chunk.byte_offset || 0,  // Add byte_offset field
      byte_length: chunk.byte_length || chunk.text.length,  // Add byte_length field
      keywords: chunk.keywords,
      embedding: chunk.embedding
    }));
    
    console.log(`📝 Inserting ${chunkRecords.length} chunk records into database...`);
    const { error } = await supabase
      .from('transcript_chunks')
      .insert(chunkRecords);
    
    if (error) {
      console.error(`❌ Database insertion error:`, error);
      console.error(`Error details:`, JSON.stringify(error, null, 2));
      throw new Error(`Failed to store chunks: ${error.message}`);
    }
    
    console.log(`✅ Successfully stored ${chunkRecords.length} chunks in database`);
  }

  async checkNewVideos() {
    try {
      // Get channels to check
      const { data: channels, error } = await supabase
        .from('channels')
        .select('id, youtube_channel_id, title, last_indexed_at')
        .eq('status', 'completed')
        .order('last_indexed_at', { ascending: true })
        .limit(10);

      if (error || !channels || channels.length === 0) {
        return;
      }

      console.log(`🔍 Checking ${channels.length} channels for new videos`);

      for (const channel of channels) {
        try {
          // Get latest video date
          const { data: latestVideo } = await supabase
            .from('videos')
            .select('published_at')
            .eq('channel_id', channel.id)
            .order('published_at', { ascending: false })
            .limit(1)
            .single();

          const sinceDate = latestVideo?.published_at || channel.last_indexed_at;

          // Fetch new videos from YouTube
          const url = new URL('https://www.googleapis.com/youtube/v3/search');
          url.searchParams.append('part', 'snippet');
          url.searchParams.append('channelId', channel.youtube_channel_id);
          url.searchParams.append('type', 'video');
          url.searchParams.append('order', 'date');
          url.searchParams.append('maxResults', '10');
          url.searchParams.append('publishedAfter', new Date(sinceDate).toISOString());
          url.searchParams.append('key', process.env.YOUTUBE_API_KEY);

          const response = await fetch(url);
          
          if (!response.ok) {
            console.error(`YouTube API error for channel ${channel.title}`);
            continue;
          }

          const data = await response.json();
          const newVideos = data.items || [];

          if (newVideos.length > 0) {
            console.log(`📺 Found ${newVideos.length} new videos for ${channel.title}`);
            
            // Process each new video
            for (const video of newVideos) {
              // Create video record
              await supabase
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

              // Process transcript
              await this.processVideo(video.id.videoId);
            }
          }

          // Update last indexed time
          await supabase
            .from('channels')
            .update({ last_indexed_at: new Date().toISOString() })
            .eq('id', channel.id);

        } catch (error) {
          console.error(`Error checking channel ${channel.title}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in checkNewVideos:', error);
    }
  }
}

export const videoProcessor = new VideoProcessor();