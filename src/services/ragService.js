import { supabase } from '../server.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

class RAGService {
  constructor() {
    this.embeddingCache = new Map();
  }

  async getEmbedding(text) {
    // Check cache first
    if (this.embeddingCache.has(text)) {
      return this.embeddingCache.get(text);
    }

    try {
      const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: text,
      });
      
      const embedding = response.data[0].embedding;
      
      // Cache the embedding
      this.embeddingCache.set(text, embedding);
      
      // Limit cache size
      if (this.embeddingCache.size > 1000) {
        const firstKey = this.embeddingCache.keys().next().value;
        this.embeddingCache.delete(firstKey);
      }
      
      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      return null;
    }
  }

  extractKeywords(text) {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'in', 'to', 
      'for', 'of', 'with', 'as', 'by', 'that', 'this', 'it', 'from',
      'be', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'do',
      'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might'
    ]);
    
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
    
    // Count word frequency
    const wordFreq = {};
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    // Get top keywords
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  async searchVideoChunks(videoId, query, limit = 5) {
    try {
      // Get query embedding
      const queryEmbedding = await this.getEmbedding(query);
      if (!queryEmbedding) {
        throw new Error('Failed to generate query embedding');
      }

      // Get video info
      const { data: video } = await supabase
        .from('videos')
        .select('id')
        .eq('youtube_id', videoId)
        .single();

      if (!video) {
        return [];
      }

      // Perform similarity search
      const { data: chunks, error } = await supabase.rpc(
        'search_transcript_chunks',
        {
          query_embedding: queryEmbedding,
          p_video_id: video.id,
          match_threshold: 0.7,
          match_count: limit
        }
      );

      if (error) {
        console.error('Search error:', error);
        return [];
      }

      // Extract keywords for hybrid search
      const keywords = this.extractKeywords(query);
      
      // Boost scores for keyword matches
      const enhancedChunks = chunks.map(chunk => {
        const keywordMatches = keywords.filter(keyword => 
          chunk.text_preview.toLowerCase().includes(keyword)
        ).length;
        
        return {
          ...chunk,
          score: chunk.similarity + (keywordMatches * 0.1),
          keywordMatches
        };
      });

      // Resort by enhanced score
      enhancedChunks.sort((a, b) => b.score - a.score);

      // Get full text from storage
      const chunksWithText = await this.retrieveChunkTexts(enhancedChunks);

      return chunksWithText;
    } catch (error) {
      console.error('Error searching video chunks:', error);
      return [];
    }
  }

  async searchChannelChunks(channelId, query, limit = 10) {
    try {
      // Get query embedding
      const queryEmbedding = await this.getEmbedding(query);
      if (!queryEmbedding) {
        throw new Error('Failed to generate query embedding');
      }

      // Perform similarity search across all channel videos
      const { data: chunks, error } = await supabase.rpc(
        'search_channel_chunks',
        {
          query_embedding: queryEmbedding,
          p_channel_id: channelId,
          match_threshold: 0.65,
          match_count: limit * 2 // Get more initially for filtering
        }
      );

      if (error) {
        console.error('Search error:', error);
        return [];
      }

      // Extract keywords for hybrid search
      const keywords = this.extractKeywords(query);
      
      // Boost scores for keyword matches and diversify videos
      const videoChunks = new Map();
      
      chunks.forEach(chunk => {
        const keywordMatches = keywords.filter(keyword => 
          chunk.text_preview.toLowerCase().includes(keyword)
        ).length;
        
        const enhancedChunk = {
          ...chunk,
          score: chunk.similarity + (keywordMatches * 0.1),
          keywordMatches
        };

        // Group by video, keep best chunks per video
        if (!videoChunks.has(chunk.video_id)) {
          videoChunks.set(chunk.video_id, []);
        }
        videoChunks.get(chunk.video_id).push(enhancedChunk);
      });

      // Balance chunks across videos
      const finalChunks = [];
      const maxChunksPerVideo = Math.ceil(limit / Math.min(videoChunks.size, 3));
      
      for (const [videoId, chunks] of videoChunks) {
        // Sort chunks by score
        chunks.sort((a, b) => b.score - a.score);
        
        // Take top chunks from this video
        finalChunks.push(...chunks.slice(0, maxChunksPerVideo));
      }

      // Final sort and limit
      finalChunks.sort((a, b) => b.score - a.score);
      const selectedChunks = finalChunks.slice(0, limit);

      // Get full text from storage
      const chunksWithText = await this.retrieveChunkTexts(selectedChunks);

      return chunksWithText;
    } catch (error) {
      console.error('Error searching channel chunks:', error);
      return [];
    }
  }

  async retrieveChunkTexts(chunks) {
    try {
      // Group chunks by storage path
      const chunksByPath = new Map();
      
      chunks.forEach(chunk => {
        if (!chunk.storage_path) return;
        
        if (!chunksByPath.has(chunk.storage_path)) {
          chunksByPath.set(chunk.storage_path, []);
        }
        chunksByPath.get(chunk.storage_path).push(chunk);
      });

      // Retrieve texts from storage
      const chunksWithText = [];
      
      for (const [path, pathChunks] of chunksByPath) {
        try {
          // Download the transcript file
          const { data, error } = await supabase.storage
            .from('transcripts')
            .download(path);
          
          if (error || !data) {
            console.error(`Failed to retrieve ${path}:`, error);
            continue;
          }

          // Parse the transcript
          const text = await data.text();
          const transcript = JSON.parse(text);
          
          // Match chunks with their full text
          pathChunks.forEach(chunk => {
            const segments = transcript.filter(seg => 
              seg.start >= chunk.start_time && 
              seg.end <= chunk.end_time
            );
            
            chunk.full_text = segments
              .map(seg => seg.text)
              .join(' ');
            
            chunksWithText.push(chunk);
          });
        } catch (error) {
          console.error(`Error processing ${path}:`, error);
        }
      }

      return chunksWithText;
    } catch (error) {
      console.error('Error retrieving chunk texts:', error);
      return chunks;
    }
  }

  formatContext(chunks, maxLength = 4000) {
    if (!chunks || chunks.length === 0) {
      return '';
    }

    let context = '';
    const addedChunks = [];

    for (const chunk of chunks) {
      const chunkText = chunk.full_text || chunk.text_preview;
      const formattedChunk = `[${this.formatTime(chunk.start_time)} - ${this.formatTime(chunk.end_time)}] ${chunkText}\n\n`;
      
      if (context.length + formattedChunk.length <= maxLength) {
        context += formattedChunk;
        addedChunks.push({
          videoId: chunk.video_id,
          videoTitle: chunk.video_title,
          startTime: chunk.start_time,
          endTime: chunk.end_time,
          text: chunkText
        });
      } else {
        break;
      }
    }

    return { context, chunks: addedChunks };
  }

  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

export const ragService = new RAGService();