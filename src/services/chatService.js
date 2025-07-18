import { supabase } from '../server.js';
import OpenAI from 'openai';
import { ragSearch } from './ragSearch.js';
import { cacheService } from './cacheService.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Chat session limits - COPIED FROM FRONTEND
const CHAT_LIMITS = {
  ANONYMOUS_USER: 10,
  SIGNED_USER: 50,
  FREE_TIER: 50,
  PREMIUM_TIER: 200
};

class ChatService {
  constructor() {
    this.activeStreams = new Map();
  }

  async streamChat({ messages, videoId, sessionId }, res) {
    const streamId = `${sessionId}-${Date.now()}`;
    this.activeStreams.set(streamId, true);

    try {
      // Get video context if provided
      let context = '';
      let contextCitations = [];
      
      if (videoId) {
        const result = await this.getVideoContext(videoId, messages);
        context = result.context;
        contextCitations = result.citations;
      }

      // Build system message - COPIED EXACTLY FROM FRONTEND
      const systemMessage = {
        role: 'system',
        content: `You are an AI assistant that has carefully watched and analyzed this YouTube video. You understand not just the words spoken, but the full context of what's being presented.

CRITICAL RULES FOR CITATIONS:
1. ONLY cite timestamps for moments you've observed in the video content below
2. When you cite a timestamp, reference what happens at that moment
3. Never make up or guess timestamps - only use ones from the video segments provided
4. If you're summarizing multiple parts, cite each specific moment you're drawing from
5. Format: "At [X:XX], you can see..." or "The creator shows at [X:XX]..."

IMPORTANT: When users ask for specific data, statistics, or numbers:
- Carefully scan ALL provided video segments for the exact information
- If the data is present, cite it with the specific timestamp
- NEVER say information isn't in the video without thoroughly checking all segments
- Look for numbers, statistics, and data points throughout the entire video

When answering:
- Speak as if you've watched the video, not read a transcript
- Reference what was shown, demonstrated, or explained
- Be conversational and helpful
- Keep responses concise but informative
- Never mention "transcript" - you're analyzing the video itself

Video content with timestamps:

${context}`
      };

      // Create OpenAI stream - COPIED EXACTLY FROM FRONTEND
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // Updated to match frontend
        messages: [systemMessage, ...messages],
        stream: true,
        temperature: 0.3,  // Lower temperature for more accurate citations
        max_tokens: 1000,  // Updated to match frontend
      });

      // Stream response chunks
      let fullResponse = '';
      let citationCount = 0;

      for await (const chunk of stream) {
        if (!this.activeStreams.get(streamId)) {
          break; // Client disconnected
        }

        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          
          // Send chunk to client
          res.write(`data: ${JSON.stringify({
            type: 'content',
            content: content,
            done: false
          })}\n\n`);
        }
      }

      // Process citations from the response
      const citations = this.extractCitations(fullResponse);
      
      // Save chat message to history
      if (sessionId) {
        await this.saveChatMessage(sessionId, messages[messages.length - 1], fullResponse, citations);
      }

      // Merge context citations with extracted citations
      const allCitations = [...contextCitations, ...citations];
      
      // Send completion signal
      res.write(`data: ${JSON.stringify({
        type: 'done',
        citations: allCitations,
        done: true
      })}\n\n`);

      res.end();

    } catch (error) {
      console.error('Chat streaming error:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: error.message
      })}\n\n`);
      res.end();
    } finally {
      this.activeStreams.delete(streamId);
    }
  }

  async getVideoContext(videoId, messages) {
    try {
      // Get the last user message
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMessage) return { context: '', citations: [] };

      // Get video details
      const { data: video } = await supabase
        .from('videos')
        .select('id, title, description')
        .eq('youtube_id', videoId)
        .single();

      if (!video) return { context: '', citations: [] };

      // Check cache first
      const cachedResult = await cacheService.getCachedTranscriptSearch(video.id, lastUserMessage.content);
      if (cachedResult) {
        console.log('🚀 Found cached transcript search result');
        return {
          context: cachedResult.context || '',
          citations: cachedResult.citations || []
        };
      }
      
      // Search for relevant chunks using RAG search
      const chunks = await ragSearch.hybridChunkSearch(video.id, lastUserMessage.content, 10);
      
      if (!chunks || chunks.length === 0) {
        return {
          context: `Video: "${video.title}"\nDescription: ${video.description}`,
          citations: []
        };
      }

      // Format context from chunks
      const context = chunks
        .map(chunk => chunk.text)
        .join('\n\n---\n\n');
      
      const fullContext = `Video: "${video.title}"\n\nRelevant transcript segments:\n${context}`;
      
      return {
        context: fullContext,
        citations: chunks.map(chunk => ({
          videoId: videoId,
          startTime: chunk.start_time,
          endTime: chunk.end_time,
          text: (chunk.text || '').substring(0, 100) + '...'
        }))
      };

    } catch (error) {
      console.error('Error getting video context:', error);
      return { context: '', citations: [] };
    }
  }

  async getEmbedding(text) {
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text,
    });
    return response.data[0].embedding;
  }

  extractCitations(text) {
    const citations = [];
    
    // Look for timestamp patterns like [00:45] or (1:23:45)
    const timestampRegex = /[\[(](\d{1,2}:)?\d{1,2}:\d{2}[\])]/g;
    const matches = text.matchAll(timestampRegex);
    
    for (const match of matches) {
      const timestamp = match[0].replace(/[\[\]()]/g, '');
      const seconds = this.parseTimestamp(timestamp);
      
      if (seconds !== null) {
        citations.push({
          timestamp,
          seconds,
          text: this.extractSurroundingText(text, match.index, 100)
        });
      }
    }
    
    return citations;
  }

  parseTimestamp(timestamp) {
    const parts = timestamp.split(':').map(p => parseInt(p, 10));
    
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    
    return null;
  }

  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  async streamChannelChat({ messages, channelId, sessionId }, res) {
    const streamId = `channel-${sessionId}-${Date.now()}`;
    this.activeStreams.set(streamId, true);

    try {
      // Get channel context
      const result = await this.getChannelContext(channelId, messages);
      const { context, citations } = result;

      // Build system message - COPIED FROM FRONTEND (adapted for backend)
      const systemMessage = {
        role: 'system',
        content: `You are a helpful assistant that can answer questions about the YouTube channel. 
        
You have access to transcripts from all videos in this channel. When answering questions:

1. Always include specific video references in your responses
2. Use timestamp citations in format [MM:SS] or [HH:MM:SS] when referencing specific moments
3. If discussing multiple videos, clearly separate the information by video
4. Provide direct quotes from transcripts when relevant
5. If you cannot find relevant information in the transcripts, say so clearly

Format your responses with proper citations and make them conversational and helpful.

Channel Context:
${context}`
      };

      // Create OpenAI stream - MATCHING FRONTEND SETTINGS
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini', // Updated to match frontend
        messages: [systemMessage, ...messages],
        stream: true,
        temperature: 0.3, // Match frontend
        max_tokens: 1000 // Updated to match frontend
      });

      // Stream response chunks
      let fullResponse = '';

      for await (const chunk of stream) {
        if (!this.activeStreams.get(streamId)) {
          break; // Client disconnected
        }

        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullResponse += content;
          
          // Send chunk to client
          res.write(`data: ${JSON.stringify({
            type: 'content',
            content: content,
            done: false
          })}\n\n`);
        }
      }

      // Extract any additional citations from the response
      const responseCitations = this.extractCitations(fullResponse);
      
      // Save chat message to history
      if (sessionId) {
        await this.saveChatMessage(sessionId, messages[messages.length - 1], fullResponse, [...citations, ...responseCitations]);
      }

      // Send completion signal with all citations
      res.write(`data: ${JSON.stringify({
        type: 'done',
        citations: [...citations, ...responseCitations],
        done: true
      })}\n\n`);

      res.end();

    } catch (error) {
      console.error('Channel chat streaming error:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: error.message
      })}\n\n`);
      res.end();
    } finally {
      this.activeStreams.delete(streamId);
    }
  }

  async getChannelContext(channelId, messages) {
    try {
      // Get the last user message
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMessage) return { context: '', citations: [] };

      // Get channel details
      const { data: channel } = await supabase
        .from('channels')
        .select('id, title, description')
        .eq('id', channelId)
        .single();

      if (!channel) return { context: '', citations: [] };

      // Check cache first
      const cachedResult = await cacheService.getCachedChannelSearch(channel.id, lastUserMessage.content);
      if (cachedResult) {
        console.log('🚀 Found cached channel search result');
        return {
          context: cachedResult.context || '',
          citations: cachedResult.citations || []
        };
      }
      
      // Search for relevant chunks across all channel videos
      const chunks = await ragSearch.hybridChannelSearch(channel.id, lastUserMessage.content, 10);
      
      if (!chunks || chunks.length === 0) {
        return {
          context: `Channel: "${channel.title}"\nDescription: ${channel.description || 'No description available'}`,
          citations: []
        };
      }

      // Format context from chunks, grouping by video
      const videoGroups = new Map();
      chunks.forEach(chunk => {
        if (!videoGroups.has(chunk.video_id)) {
          videoGroups.set(chunk.video_id, {
            title: chunk.videos?.title || 'Unknown Video',
            chunks: []
          });
        }
        videoGroups.get(chunk.video_id).chunks.push(chunk);
      });

      let context = `Channel: "${channel.title}"\n\nRelevant content from videos:\n\n`;
      const citations = [];

      for (const [videoId, group] of videoGroups) {
        context += `Video: "${group.title}"\n`;
        
        group.chunks.forEach(chunk => {
          const chunkText = chunk.text || chunk.text_preview || '';
          context += `[${this.formatTime(chunk.start_time)} - ${this.formatTime(chunk.end_time)}] ${chunkText}\n`;
          
          citations.push({
            videoId: videoId,
            videoTitle: group.title,
            startTime: chunk.start_time,
            endTime: chunk.end_time,
            text: chunkText.substring(0, 100) + '...'
          });
        });
        
        context += '\n';
      }

      return { context, citations };

    } catch (error) {
      console.error('Error getting channel context:', error);
      return { context: '', citations: [] };
    }
  }

  extractSurroundingText(text, index, length) {
    const start = Math.max(0, index - length);
    const end = Math.min(text.length, index + length);
    return text.substring(start, end).trim();
  }

  async saveChatMessage(sessionId, userMessage, assistantResponse, citations) {
    try {
      // Save user message
      await supabase
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'user',
          content: userMessage.content,
          created_at: new Date().toISOString()
        });

      // Save assistant response
      await supabase
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'assistant',
          content: assistantResponse,
          citations: citations.length > 0 ? citations : null,
          created_at: new Date().toISOString()
        });

      // Update session activity
      await supabase
        .from('chat_sessions')
        .update({
          last_activity: new Date().toISOString(),
          message_count: supabase.sql`message_count + 2`
        })
        .eq('id', sessionId);

    } catch (error) {
      console.error('Error saving chat message:', error);
    }
  }

  async generateSummary(videoId) {
    try {
      // Get video and transcript chunks
      const { data: video } = await supabase
        .from('videos')
        .select(`
          id,
          title,
          description,
          transcript_chunks (
            text_preview,
            start_time,
            end_time
          )
        `)
        .eq('youtube_id', videoId)
        .single();

      if (!video || !video.transcript_chunks || video.transcript_chunks.length === 0) {
        return null;
      }

      // Combine chunks into full transcript
      const fullTranscript = video.transcript_chunks
        .sort((a, b) => a.start_time - b.start_time)
        .map(chunk => chunk.text_preview)
        .join(' ');

      // Generate summary using OpenAI
      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at creating concise, informative summaries of video content.'
          },
          {
            role: 'user',
            content: `Please provide a comprehensive summary of this video titled "${video.title}". 
            
            Video description: ${video.description}
            
            Transcript: ${fullTranscript.substring(0, 8000)}
            
            Create a summary that includes:
            1. Main topics covered
            2. Key insights or takeaways
            3. Notable quotes or moments
            4. Overall theme or purpose
            
            Keep the summary under 500 words.`
          }
        ],
        temperature: 0.7,
        max_tokens: 600
      });

      return response.choices[0].message.content;

    } catch (error) {
      console.error('Error generating summary:', error);
      return null;
    }
  }

  // Handle disconnections
  disconnect(streamId) {
    this.activeStreams.delete(streamId);
  }
}

export const chatService = new ChatService();