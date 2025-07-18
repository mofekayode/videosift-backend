import express from 'express';
import { supabase } from '../server.js';
import { channelProcessor } from '../services/channelProcessor.js';

const router = express.Router();

// Check for new videos in channels (for future use when we support updates)
router.post('/check-new-videos', async (req, res) => {
  try {
    // For beta, we only process initial 20 videos
    // This endpoint is here for future expansion
    console.log('🔍 Checking for new videos (currently disabled for beta)');
    
    res.json({ 
      success: true, 
      message: 'New video checking is disabled during beta. Channels are processed once with up to 20 videos.',
      processed: 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process pending channels
router.post('/process-channels', async (req, res) => {
  try {
    console.log('🚀 Processing pending channels via cron');
    
    // Start processing asynchronously
    channelProcessor.processPendingChannels().catch(err => {
      console.error('Channel processing error:', err);
    });
    
    res.json({ 
      success: true, 
      message: 'Channel processing triggered' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cron health check
router.get('/health', async (req, res) => {
  try {
    // Get last cron run times
    const { data: lastRuns } = await supabase
      .from('cron_logs')
      .select('job_name, started_at, completed_at, status')
      .order('started_at', { ascending: false })
      .limit(10);
    
    // Check if crons are running properly
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    const recentRuns = lastRuns?.filter(run => 
      new Date(run.started_at) > oneHourAgo
    ) || [];
    
    const healthy = recentRuns.length > 0;
    
    res.json({
      success: true,
      healthy,
      lastRuns: lastRuns || [],
      message: healthy 
        ? 'Cron jobs are running normally' 
        : 'Warning: No cron jobs have run in the last hour'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;