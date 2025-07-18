import { OpenAI } from 'openai';
import { supabase } from '../server.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Hybrid search combining semantic and keyword search
export async function hybridChunkSearch(videoId, query, topK = 5) {
  console.log(`🔍 Searching for: "${query}" in video ${videoId} (top ${topK} results)`);
  
  // 1. Generate query embedding
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;
  
  // 2. Extract keywords from query
  const queryKeywords = extractKeywords(query);
  
  // 3. Get ALL chunks for this video to calculate similarity
  const { data: allChunks, error: semanticError } = await supabase
    .from('transcript_chunks')
    .select('*')
    .eq('video_id', videoId)
    .order('chunk_index');
  
  if (semanticError) {
    console.error('Semantic search error:', semanticError);
    throw new Error('Failed to search chunks');
  }
  
  // Calculate similarity scores for ALL chunks
  console.log(`📊 Calculating similarity for ${allChunks?.length || 0} chunks`);
  
  const resultsWithSimilarity = allChunks?.map(chunk => {
    // Simple cosine similarity calculation
    let similarity = 0;
    if (chunk.embedding && Array.isArray(chunk.embedding)) {
      const dotProduct = chunk.embedding.reduce((sum, val, idx) => 
        sum + (val * queryEmbedding[idx]), 0
      );
      const chunkMagnitude = Math.sqrt(chunk.embedding.reduce((sum, val) => 
        sum + (val * val), 0
      ));
      const queryMagnitude = Math.sqrt(queryEmbedding.reduce((sum, val) => 
        sum + (val * val), 0
      ));
      similarity = dotProduct / (chunkMagnitude * queryMagnitude);
    }
    return { ...chunk, similarity };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, topK) || [];
  
  console.log(`🎯 Top semantic results (similarities): ${resultsWithSimilarity.slice(0, 3).map(r => r.similarity.toFixed(3)).join(', ')}`);
  
  // Log keywords for debugging
  console.log(`🔑 Query keywords: ${queryKeywords.join(', ')}`);
  
  // 4. Perform keyword search if we have keywords
  let keywordResults = [];
  if (queryKeywords.length > 0 && allChunks) {
    // Filter chunks that contain any of the query keywords
    keywordResults = allChunks.filter(chunk => {
      if (!chunk.keywords || !Array.isArray(chunk.keywords)) return false;
      
      // Check if any query keyword matches any chunk keyword
      return queryKeywords.some(queryKeyword => 
        chunk.keywords.some((chunkKeyword) => 
          chunkKeyword.toLowerCase().includes(queryKeyword.toLowerCase()) ||
          queryKeyword.toLowerCase().includes(chunkKeyword.toLowerCase())
        )
      );
    });
  }
  
  // 5. Merge and deduplicate results
  const allResults = new Map();
  
  // Add semantic results
  resultsWithSimilarity?.forEach((result) => {
    allResults.set(result.id, {
      ...result,
      score: result.similarity
    });
  });
  
  // Add keyword results (boost score if already in semantic)
  keywordResults.forEach((result) => {
    if (allResults.has(result.id)) {
      const existing = allResults.get(result.id);
      existing.score = (existing.score || 0) + 0.3; // Boost hybrid matches
    } else {
      allResults.set(result.id, {
        ...result,
        score: 0.5 // Base score for keyword-only matches
      });
    }
  });
  
  // 6. Sort by score and return top K
  const sortedResults = Array.from(allResults.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK);
  
  // 7. Load text from storage if needed
  const chunksWithText = await loadChunkTexts(videoId, sortedResults);
  
  return chunksWithText;
}

// Load chunk texts from storage
async function loadChunkTexts(videoId, chunks) {
  // If chunks already have text, return as is
  if (chunks.every(chunk => chunk.text)) {
    return chunks;
  }
  
  // Otherwise, load from storage
  const chunkIds = chunks.map(c => c.id);
  
  const { data: chunksWithText, error } = await supabase
    .from('transcript_chunks')
    .select('id, text')
    .in('id', chunkIds);
  
  if (error) {
    console.error('Error loading chunk texts:', error);
    return chunks;
  }
  
  // Map texts back to chunks
  const textMap = new Map(chunksWithText.map(c => [c.id, c.text]));
  
  return chunks.map(chunk => ({
    ...chunk,
    text: textMap.get(chunk.id) || chunk.text || ''
  }));
}

// Extract keywords from text
function extractKeywords(text) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'what', 'when', 'where', 'who', 'why', 'how', 'which', 'that', 'this'
  ]);
  
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  // Get unique keywords
  return [...new Set(words)];
}

// Search across multiple videos in a channel
export async function hybridChannelSearch(channelId, query, topK = 10) {
  console.log(`🔍 Searching across channel ${channelId} for: "${query}"`);
  
  // Get all videos in the channel
  const { data: videos, error: videosError } = await supabase
    .from('videos')
    .select('id')
    .eq('channel_id', channelId)
    .eq('transcript_cached', true);
  
  if (videosError || !videos || videos.length === 0) {
    console.error('No videos found for channel:', channelId);
    return [];
  }
  
  const videoIds = videos.map(v => v.id);
  console.log(`📺 Searching across ${videoIds.length} videos`);
  
  // Generate query embedding once
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;
  
  // Extract keywords
  const queryKeywords = extractKeywords(query);
  
  // Get all chunks from all videos
  const { data: allChunks, error: chunksError } = await supabase
    .from('transcript_chunks')
    .select(`
      *,
      videos (
        title,
        youtube_id
      )
    `)
    .in('video_id', videoIds);
  
  if (chunksError) {
    console.error('Error fetching chunks:', chunksError);
    throw new Error('Failed to search channel');
  }
  
  // Calculate similarity for all chunks
  const resultsWithSimilarity = allChunks?.map(chunk => {
    let similarity = 0;
    if (chunk.embedding && Array.isArray(chunk.embedding)) {
      const dotProduct = chunk.embedding.reduce((sum, val, idx) => 
        sum + (val * queryEmbedding[idx]), 0
      );
      const chunkMagnitude = Math.sqrt(chunk.embedding.reduce((sum, val) => 
        sum + (val * val), 0
      ));
      const queryMagnitude = Math.sqrt(queryEmbedding.reduce((sum, val) => 
        sum + (val * val), 0
      ));
      similarity = dotProduct / (chunkMagnitude * queryMagnitude);
    }
    return { ...chunk, similarity };
  }) || [];
  
  // Sort by similarity and get top results
  const topResults = resultsWithSimilarity
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
  
  // Load texts for top results
  const chunksWithText = await loadChunkTexts(null, topResults);
  
  return chunksWithText;
}

export const ragSearch = {
  hybridChunkSearch,
  hybridChannelSearch,
  extractKeywords
};