import { supabase } from '../server.js';
import crypto from 'crypto';

// Cache duration: 15 minutes
const CACHE_DURATION = 15 * 60 * 1000;

class CacheService {
  constructor() {
    // In-memory cache for quick access
    this.memoryCache = new Map();
    
    // Clean up expired entries every 5 minutes
    setInterval(() => this.cleanupExpired(), 5 * 60 * 1000);
  }

  // Generate cache key
  generateKey(prefix, ...params) {
    const str = params.join(':');
    const hash = crypto.createHash('md5').update(str).digest('hex');
    return `${prefix}:${hash}`;
  }

  // Get from cache
  async get(key) {
    // Check memory cache first
    const memCached = this.memoryCache.get(key);
    if (memCached && memCached.expiresAt > Date.now()) {
      console.log(`💾 Cache hit (memory): ${key}`);
      return memCached.data;
    }

    // Check database cache
    try {
      const { data, error } = await supabase
        .from('cache')
        .select('data, expires_at')
        .eq('key', key)
        .single();

      if (error || !data) {
        return null;
      }

      const expiresAt = new Date(data.expires_at).getTime();
      if (expiresAt > Date.now()) {
        console.log(`💾 Cache hit (db): ${key}`);
        // Store in memory cache for faster access
        this.memoryCache.set(key, {
          data: data.data,
          expiresAt
        });
        return data.data;
      }

      // Expired, delete it
      await supabase.from('cache').delete().eq('key', key);
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  // Set cache
  async set(key, data, duration = CACHE_DURATION) {
    const expiresAt = Date.now() + duration;
    
    // Store in memory
    this.memoryCache.set(key, {
      data,
      expiresAt
    });

    // Store in database
    try {
      await supabase
        .from('cache')
        .upsert({
          key,
          data,
          expires_at: new Date(expiresAt).toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'key'
        });
      
      console.log(`💾 Cached: ${key}`);
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  // Delete from cache
  async delete(key) {
    this.memoryCache.delete(key);
    
    try {
      await supabase.from('cache').delete().eq('key', key);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  // Clean up expired entries
  async cleanupExpired() {
    // Clean memory cache
    const now = Date.now();
    for (const [key, value] of this.memoryCache.entries()) {
      if (value.expiresAt <= now) {
        this.memoryCache.delete(key);
      }
    }

    // Clean database cache
    try {
      await supabase
        .from('cache')
        .delete()
        .lt('expires_at', new Date().toISOString());
    } catch (error) {
      console.error('Cache cleanup error:', error);
    }
  }

  // Cache methods for specific use cases
  async getCachedTranscriptSearch(videoId, query) {
    const key = this.generateKey('transcript_search', videoId, query);
    return this.get(key);
  }

  async cacheTranscriptSearch(videoId, query, result) {
    const key = this.generateKey('transcript_search', videoId, query);
    await this.set(key, result);
  }

  async getCachedChannelSearch(channelId, query) {
    const key = this.generateKey('channel_search', channelId, query);
    return this.get(key);
  }

  async cacheChannelSearch(channelId, query, result) {
    const key = this.generateKey('channel_search', channelId, query);
    await this.set(key, result);
  }

  async getCachedSummary(videoId) {
    const key = this.generateKey('video_summary', videoId);
    return this.get(key);
  }

  async cacheSummary(videoId, summary) {
    const key = this.generateKey('video_summary', videoId);
    // Cache summaries for longer (1 hour)
    await this.set(key, summary, 60 * 60 * 1000);
  }
}

export const cacheService = new CacheService();