import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { channelProcessor } from './services/channelProcessor.js';
import { videoProcessor } from './services/videoProcessor.js';
import { errorTracker } from './services/errorTracker.js';
import apiRoutes from './routes/api.js';
import userRoutes from './routes/user.js';
import videoRoutes from './routes/video.js';
import waitlistRoutes from './routes/waitlist.js';
import cronRoutes from './routes/cron.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';

const app = express();
const PORT = process.env.PORT || 4000;

// Initialize Supabase
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://vidsift.com'],
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'vidsift-backend',
    timestamp: new Date().toISOString() 
  });
});

// API routes
app.use('/api', apiRoutes);
app.use('/api/user', userRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  // Track the error
  errorTracker.trackApiError(req, res, err).catch(console.error);

  // Send error response
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ===== BACKGROUND JOBS =====
// Process pending channels every 5 seconds
setInterval(async () => {
  try {
    await channelProcessor.processPendingChannels();
  } catch (error) {
    console.error('Channel processing error:', error);
    errorTracker.track(error, { type: 'background_job', job: 'channel_processing' });
  }
}, 5000); // 5 seconds

// Log channel processing status every minute for monitoring
cron.schedule('* * * * *', async () => {
  const jobId = await logCronStart('channel_processing_status');
  
  try {
    // Just log the status, actual processing happens every 5 seconds
    console.log('⏰ Channel processing is running every 5 seconds');
    await logCronComplete(jobId);
  } catch (error) {
    await logCronError(jobId, error);
  }
});

// Check for new videos every 6 hours
cron.schedule('0 */6 * * *', async () => {
  console.log('⏰ Running new video check cron...');
  const jobId = await logCronStart('new_video_check');
  
  try {
    await videoProcessor.checkNewVideos();
    await logCronComplete(jobId);
  } catch (error) {
    console.error('Cron error:', error);
    await logCronError(jobId, error);
    errorTracker.track(error, { type: 'cron', job: 'new_video_check' });
  }
});


// Cron job logging helpers
async function logCronStart(jobName) {
  try {
    const { data } = await supabase
      .from('cron_logs')
      .insert({
        job_name: jobName,
        status: 'started',
        started_at: new Date().toISOString()
      })
      .select('id')
      .single();
    
    return data?.id;
  } catch (error) {
    console.error('Failed to log cron start:', error);
    return null;
  }
}

async function logCronComplete(jobId, metadata = null) {
  if (!jobId) return;
  
  try {
    await supabase
      .from('cron_logs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata
      })
      .eq('id', jobId);
  } catch (error) {
    console.error('Failed to log cron completion:', error);
  }
}

async function logCronError(jobId, error) {
  if (!jobId) return;
  
  try {
    await supabase
      .from('cron_logs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message || String(error)
      })
      .eq('id', jobId);
  } catch (logError) {
    console.error('Failed to log cron error:', logError);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 VidSift Backend running on port ${PORT}`);
  console.log('✅ Cron jobs scheduled');
  console.log('✅ Ready to process channels and videos');
});