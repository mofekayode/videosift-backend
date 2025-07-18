import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { supabase } from '../server.js';

const router = express.Router();

// Admin middleware - check if user is admin
const adminMiddleware = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if user is admin (you can implement your own admin logic)
    const { data: user } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (user?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

// Get cron status
router.get('/cron-status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Get cron logs
    const { data: cronLogs, error } = await supabase
      .from('cron_logs')
      .select('*')
      .gte('started_at', since.toISOString())
      .order('started_at', { ascending: false });

    if (error) throw error;

    // Group by job name
    const jobStats = {};
    cronLogs?.forEach(log => {
      if (!jobStats[log.job_name]) {
        jobStats[log.job_name] = {
          total: 0,
          success: 0,
          failed: 0,
          running: 0,
          lastRun: null,
          avgDuration: 0,
          durations: []
        };
      }

      const stats = jobStats[log.job_name];
      stats.total++;
      
      if (log.status === 'completed') {
        stats.success++;
        if (log.completed_at && log.started_at) {
          const duration = new Date(log.completed_at) - new Date(log.started_at);
          stats.durations.push(duration);
        }
      } else if (log.status === 'failed') {
        stats.failed++;
      } else if (log.status === 'running') {
        stats.running++;
      }

      if (!stats.lastRun || new Date(log.started_at) > new Date(stats.lastRun)) {
        stats.lastRun = log.started_at;
      }
    });

    // Calculate average durations
    Object.values(jobStats).forEach(stats => {
      if (stats.durations.length > 0) {
        stats.avgDuration = Math.round(
          stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length
        );
      }
      delete stats.durations; // Remove raw data
    });

    res.json({
      success: true,
      period: `${hours} hours`,
      jobStats,
      recentLogs: cronLogs?.slice(0, 20) || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get error statistics
router.get('/error-stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Get error logs
    const { data: errors, error } = await supabase
      .from('error_logs')
      .select('*')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group errors by type
    const errorStats = {
      byType: {},
      byEndpoint: {},
      byUser: {},
      total: errors?.length || 0,
      criticalCount: 0
    };

    errors?.forEach(err => {
      // By type
      const type = err.error_type || 'unknown';
      errorStats.byType[type] = (errorStats.byType[type] || 0) + 1;

      // By endpoint
      if (err.api_endpoint) {
        errorStats.byEndpoint[err.api_endpoint] = 
          (errorStats.byEndpoint[err.api_endpoint] || 0) + 1;
      }

      // By user
      if (err.user_id) {
        if (!errorStats.byUser[err.user_id]) {
          errorStats.byUser[err.user_id] = {
            count: 0,
            email: err.user_email
          };
        }
        errorStats.byUser[err.user_id].count++;
      }

      // Count critical errors
      if (err.severity === 'critical' || err.error_type === 'INTERNAL_ERROR') {
        errorStats.criticalCount++;
      }
    });

    // Get top error users
    const topErrorUsers = Object.entries(errorStats.byUser)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10)
      .map(([userId, data]) => ({
        userId,
        ...data
      }));

    res.json({
      success: true,
      period: `${hours} hours`,
      stats: {
        ...errorStats,
        topErrorUsers
      },
      recentErrors: errors?.slice(0, 50) || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get system statistics
router.get('/system-stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Get various system stats
    const [
      channelStats,
      videoStats,
      userStats,
      queueStats
    ] = await Promise.all([
      // Channel stats
      supabase.from('channels').select('status', { count: 'exact' }),
      
      // Video stats
      supabase.from('videos').select('transcript_cached, chunks_processed', { count: 'exact' }),
      
      // User stats
      supabase.from('users').select('created_at'),
      
      // Queue stats
      supabase.from('channel_queue').select('status')
    ]);

    // Process stats
    const stats = {
      channels: {
        total: channelStats.data?.length || 0,
        byStatus: {}
      },
      videos: {
        total: videoStats.data?.length || 0,
        transcribed: videoStats.data?.filter(v => v.transcript_cached).length || 0,
        processed: videoStats.data?.filter(v => v.chunks_processed).length || 0
      },
      users: {
        total: userStats.data?.length || 0,
        last24h: userStats.data?.filter(u => 
          new Date(u.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
        ).length || 0,
        last7d: userStats.data?.filter(u => 
          new Date(u.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        ).length || 0
      },
      queue: {
        pending: queueStats.data?.filter(q => q.status === 'pending').length || 0,
        processing: queueStats.data?.filter(q => q.status === 'processing').length || 0,
        completed: queueStats.data?.filter(q => q.status === 'completed').length || 0,
        failed: queueStats.data?.filter(q => q.status === 'failed').length || 0
      }
    };

    // Count channels by status
    channelStats.data?.forEach(channel => {
      stats.channels.byStatus[channel.status] = 
        (stats.channels.byStatus[channel.status] || 0) + 1;
    });

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;