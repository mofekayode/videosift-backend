import { supabase } from '../server.js';

const RATE_LIMITS = {
  anonymous: {
    chat: { hourly: 5, daily: 5 },
    video_upload: { hourly: null, daily: 2 },
    channel_process: { hourly: null, daily: 0 }
  },
  user: {
    chat: { hourly: 5, daily: 5 },
    video_upload: { hourly: null, daily: 10 },
    channel_process: { hourly: null, daily: 1 }
  },
  premium: {
    chat: { hourly: 50, daily: 200 },
    video_upload: { hourly: null, daily: 50 },
    channel_process: { hourly: null, daily: 10 }
  }
};

class RateLimiter {
  constructor() {
    this.cache = new Map();
  }

  getClientIp(req) {
    // Get IP from various headers
    const forwarded = req.headers['x-forwarded-for'];
    const real = req.headers['x-real-ip'];
    const cloudflare = req.headers['cf-connecting-ip'];
    
    if (cloudflare) return cloudflare;
    if (forwarded) return forwarded.split(',')[0].trim();
    if (real) return real;
    
    return req.connection?.remoteAddress || req.ip || 'unknown';
  }

  getCacheKey(identifier, action, window) {
    return `${identifier}:${action}:${window}`;
  }

  async checkLimit(identifier, action, userType = 'anonymous') {
    const limits = RATE_LIMITS[userType]?.[action];
    if (!limits) {
      return { allowed: true, remaining: null };
    }

    const now = new Date();
    const results = [];

    // Check hourly limit
    if (limits.hourly !== null) {
      const hourlyResult = await this.checkWindowLimit(
        identifier,
        action,
        'hour',
        limits.hourly,
        now
      );
      results.push(hourlyResult);
    }

    // Check daily limit
    if (limits.daily !== null) {
      const dailyResult = await this.checkWindowLimit(
        identifier,
        action,
        'day',
        limits.daily,
        now
      );
      results.push(dailyResult);
    }

    // Return the most restrictive result
    const mostRestrictive = results.reduce((prev, current) => {
      if (!current.allowed) return current;
      if (!prev.allowed) return prev;
      if (current.remaining < prev.remaining) return current;
      return prev;
    }, { allowed: true, remaining: Infinity });

    return mostRestrictive;
  }

  async checkWindowLimit(identifier, action, window, limit, now) {
    try {
      // Calculate window start time
      const windowStart = new Date(now);
      if (window === 'hour') {
        windowStart.setHours(windowStart.getHours() - 1);
      } else {
        windowStart.setDate(windowStart.getDate() - 1);
      }

      // Check cache first
      const cacheKey = this.getCacheKey(identifier, action, window);
      const cached = this.cache.get(cacheKey);
      
      if (cached && cached.expires > now) {
        const remaining = Math.max(0, limit - cached.count);
        return {
          allowed: remaining > 0,
          remaining,
          limit,
          window,
          resetAt: cached.resetAt
        };
      }

      // Query database - just count the records
      const { count, error } = await supabase
        .from('rate_limits')
        .select('*', { count: 'exact', head: true })
        .eq('identifier', identifier)
        .eq('action', action)
        .gte('created_at', windowStart.toISOString());

      if (error) {
        console.error('Rate limit check error:', error);
        // Fail open on error
        return { allowed: true, remaining: limit };
      }

      const usageCount = count || 0;
      const remaining = Math.max(0, limit - usageCount);

      // Calculate reset time
      let resetAt = new Date(windowStart);
      if (window === 'hour') {
        resetAt.setHours(resetAt.getHours() + 1);
      } else {
        resetAt.setDate(resetAt.getDate() + 1);
      }

      // Cache the result
      this.cache.set(cacheKey, {
        count: usageCount,
        expires: new Date(now.getTime() + 60000), // Cache for 1 minute
        resetAt
      });

      // Limit cache size
      if (this.cache.size > 1000) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      return {
        allowed: remaining > 0,
        remaining,
        limit,
        window,
        resetAt
      };
    } catch (error) {
      console.error('Rate limit error:', error);
      // Fail open
      return { allowed: true, remaining: limit };
    }
  }

  async recordUsage(identifier, action) {
    try {
      const { error } = await supabase
        .from('rate_limits')
        .insert({
          identifier,
          action,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.error('Rate limit record error:', error);
      }

      // Invalidate cache
      this.cache.delete(this.getCacheKey(identifier, action, 'hour'));
      this.cache.delete(this.getCacheKey(identifier, action, 'day'));
    } catch (error) {
      console.error('Rate limit record error:', error);
    }
  }

  async cleanupOldRecords() {
    try {
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      const { error } = await supabase
        .from('rate_limits')
        .delete()
        .lt('created_at', twoDaysAgo.toISOString());

      if (error) {
        console.error('Rate limit cleanup error:', error);
      }
    } catch (error) {
      console.error('Rate limit cleanup error:', error);
    }
  }
}

const rateLimiter = new RateLimiter();

// Cleanup old records periodically
setInterval(() => {
  rateLimiter.cleanupOldRecords().catch(err => {
    console.error('Rate limit cleanup interval error:', err);
  });
}, 3600000); // Every hour

export function rateLimitMiddleware(action) {
  return async (req, res, next) => {
    try {
      // Skip rate limiting for API key authentication
      if (req.user?.isApiKey) {
        return next();
      }

      // Determine identifier and user type
      let identifier;
      let userType = 'anonymous';

      if (req.user) {
        identifier = `user:${req.user.id}`;
        userType = req.user.premium ? 'premium' : 'user';
      } else {
        const ip = rateLimiter.getClientIp(req);
        identifier = `ip:${ip}`;
      }

      // Check rate limit
      const result = await rateLimiter.checkLimit(identifier, action, userType);

      // Add headers
      res.setHeader('X-RateLimit-Limit', result.limit || 'unlimited');
      res.setHeader('X-RateLimit-Remaining', result.remaining || 'unlimited');
      
      if (result.resetAt) {
        res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());
      }

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Too many ${action} requests. Please try again later.`,
          limit: result.limit,
          window: result.window,
          resetAt: result.resetAt
        });
      }

      // Record usage
      await rateLimiter.recordUsage(identifier, action);

      next();
    } catch (error) {
      console.error('Rate limit middleware error:', error);
      // Fail open
      next();
    }
  };
}

export { rateLimiter };