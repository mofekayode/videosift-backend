import { supabase } from '../server.js';

class ErrorTracker {
  constructor() {
    this.errorBuffer = [];
    this.flushInterval = null;
    this.startPeriodicFlush();
  }

  async track(error, context = {}) {
    try {
      const errorData = {
        message: error.message || String(error),
        stack: error.stack || null,
        type: error.name || 'Error',
        context: {
          ...context,
          timestamp: new Date().toISOString(),
          service: 'backend-v0',
          environment: process.env.NODE_ENV || 'development'
        }
      };

      // Add to buffer
      this.errorBuffer.push(errorData);

      // Log to console in development
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error tracked:', errorData);
      }

      // Flush if buffer is getting large
      if (this.errorBuffer.length >= 10) {
        await this.flush();
      }
    } catch (trackingError) {
      console.error('Error tracking failed:', trackingError);
    }
  }

  async trackApiError(req, res, error) {
    const context = {
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      userId: req.user?.id,
      statusCode: res.statusCode,
      query: req.query,
      body: this.sanitizeBody(req.body)
    };

    await this.track(error, context);
  }

  sanitizeBody(body) {
    if (!body) return null;

    const sanitized = { ...body };
    const sensitiveKeys = ['password', 'token', 'apiKey', 'secret', 'authorization'];

    Object.keys(sanitized).forEach(key => {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      }
    });

    return sanitized;
  }

  async flush() {
    if (this.errorBuffer.length === 0) return;

    const errors = [...this.errorBuffer];
    this.errorBuffer = [];

    try {
      // Store errors in database
      const errorRecords = errors.map(error => ({
        message: error.message,
        stack: error.stack,
        type: error.type,
        context: error.context,
        created_at: error.context.timestamp
      }));

      const { error: dbError } = await supabase
        .from('error_logs')
        .insert(errorRecords);

      if (dbError) {
        console.error('Failed to store errors in database:', dbError);
        // Re-add to buffer to retry later
        this.errorBuffer.unshift(...errors);
      }
    } catch (flushError) {
      console.error('Error flush failed:', flushError);
      // Re-add to buffer to retry later
      this.errorBuffer.unshift(...errors);
    }
  }

  startPeriodicFlush() {
    // Flush errors every 30 seconds
    this.flushInterval = setInterval(() => {
      this.flush().catch(err => {
        console.error('Periodic flush failed:', err);
      });
    }, 30000);
  }

  async getErrorStats(hours = 24) {
    try {
      const since = new Date();
      since.setHours(since.getHours() - hours);

      // Get error counts by type
      const { data: errorsByType } = await supabase
        .from('error_logs')
        .select('type')
        .gte('created_at', since.toISOString());

      // Get error counts by endpoint
      const { data: errorsByEndpoint } = await supabase
        .from('error_logs')
        .select('context')
        .gte('created_at', since.toISOString());

      // Process stats
      const typeCount = {};
      const endpointCount = {};

      errorsByType?.forEach(error => {
        typeCount[error.type] = (typeCount[error.type] || 0) + 1;
      });

      errorsByEndpoint?.forEach(error => {
        const path = error.context?.path;
        if (path) {
          endpointCount[path] = (endpointCount[path] || 0) + 1;
        }
      });

      return {
        totalErrors: errorsByType?.length || 0,
        byType: typeCount,
        byEndpoint: endpointCount,
        timeRange: { hours, since }
      };
    } catch (error) {
      console.error('Failed to get error stats:', error);
      return null;
    }
  }

  async cleanupOldErrors(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const { error } = await supabase
        .from('error_logs')
        .delete()
        .lt('created_at', cutoffDate.toISOString());

      if (error) {
        console.error('Error cleanup failed:', error);
      }
    } catch (error) {
      console.error('Error cleanup failed:', error);
    }
  }

  // Graceful shutdown
  async shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

export const errorTracker = new ErrorTracker();

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  errorTracker.track(error, { type: 'uncaughtException' }).finally(() => {
    process.exit(1);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  errorTracker.track(new Error(String(reason)), { type: 'unhandledRejection' });
});

// Cleanup on shutdown
process.on('SIGINT', async () => {
  await errorTracker.shutdown();
});

process.on('SIGTERM', async () => {
  await errorTracker.shutdown();
});

// Cleanup old errors daily
setInterval(() => {
  errorTracker.cleanupOldErrors().catch(err => {
    console.error('Error cleanup interval failed:', err);
  });
}, 86400000); // Every 24 hours