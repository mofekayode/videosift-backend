import { Resend } from 'resend';

class EmailService {
  constructor() {
    this.resend = process.env.RESEND_API_KEY 
      ? new Resend(process.env.RESEND_API_KEY)
      : null;
  }

  async sendChannelProcessingNotification(data) {
    if (!this.resend) {
      console.log('📧 Email service not configured (no Resend API key)');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      console.log(`📧 Sending email notification to ${data.userEmail} for channel: ${data.channelTitle}`);
      
      const emailContent = data.status === 'completed' 
        ? this.getSuccessEmailContent(data)
        : this.getFailureEmailContent(data);

      const result = await this.resend.emails.send({
        from: 'VidSift <noreply@vidsift.com>',
        to: data.userEmail,
        subject: data.status === 'completed' 
          ? `✅ ${data.channelTitle} is ready for AI chat!`
          : `Channel processing failed: ${data.channelTitle}`,
        html: emailContent
      });

      // Log the full result for debugging
      console.log('📧 Email API Response:', {
        hasData: !!result.data,
        hasError: !!result.error,
        data: result.data,
        error: result.error
      });
      
      if (result.error) {
        console.error('❌ Resend API error:', result.error);
        return { success: false, error: result.error.message || 'Email send failed' };
      }
      
      const emailId = result.data?.id || 'sent';
      console.log('✅ Email sent successfully with ID:', emailId);
      
      return { success: true, id: emailId };

    } catch (error) {
      console.error('❌ Failed to send email - Exception:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Keep old method for backward compatibility but use new one
  async sendChannelCompletionEmail(userEmail, channelTitle, videosProcessed, totalVideos) {
    return this.sendChannelProcessingNotification({
      userEmail,
      userName: this.extractUserNameFromEmail(userEmail),
      channelTitle,
      videosProcessed,
      totalVideos,
      status: 'completed'
    });
  }

  async sendProcessingFailureEmail(userEmail, channelTitle, errorMessage) {
    if (!this.resend) {
      console.log('📧 Email service not configured (no Resend API key)');
      return false;
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: 'VidSift <noreply@vidsift.com>',
        to: userEmail,
        subject: `Channel processing failed: ${channelTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626;">Channel Processing Failed</h2>
            
            <p>We encountered an issue while processing the YouTube channel:</p>
            
            <div style="background: #fee; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin: 0 0 10px 0; color: #333;">${channelTitle}</h3>
              <p style="margin: 0; color: #666;">
                Error: ${errorMessage}
              </p>
            </div>
            
            <p>Common issues and solutions:</p>
            <ul>
              <li><strong>Channel not found:</strong> Check if the channel URL is correct</li>
              <li><strong>No videos found:</strong> The channel might not have public videos</li>
              <li><strong>API limit reached:</strong> Try again in a few hours</li>
            </ul>
            
            <div style="margin: 30px 0;">
              <a href="https://vidsift.com/channels" 
                 style="background: #8b5cf6; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Try Another Channel
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              Need help? Reply to this email and we'll assist you.<br>
              The VidSift Team
            </p>
          </div>
        `
      });

      if (error) {
        console.error('Failed to send error email:', error);
        return false;
      }

      return true;

    } catch (error) {
      console.error('Email service error:', error);
      return false;
    }
  }

  extractUserNameFromEmail(email) {
    return email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  getSuccessEmailContent(data) {
    // COPIED EXACTLY FROM FRONTEND
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Channel Ready - VidSift</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; margin-top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .header { background: #f3f4f6; color: #0f172a; padding: 32px 24px; text-align: center; border-bottom: 1px solid #e5e7eb; }
          .content { padding: 32px 24px; }
          .button { display: inline-block; background: #0f172a; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
          .stats { background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e2e8f0; }
          .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
          .stat-row:last-child { border-bottom: none; }
          .stat-label { color: #64748b; font-size: 14px; }
          .stat-value { font-weight: 600; color: #0f172a; font-size: 16px; }
          .success-value { color: #059669; }
          .warning-value { color: #d97706; }
          .info-value { color: #3b82f6; }
          .footer { background: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 14px; border-top: 1px solid #e2e8f0; }
          .warning-box { background: #fef3c7; border: 1px solid #fbbf24; color: #92400e; padding: 16px; border-radius: 6px; margin: 16px 0; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #0f172a;">Channel Ready! 🎉</h1>
            <p style="margin: 12px 0 0 0; font-size: 16px; opacity: 0.9; color: #475569;">Your YouTube channel has been successfully indexed</p>
          </div>
          
          <div class="content">
            <p style="font-size: 16px; line-height: 1.6;">Hi ${data.userName || 'there'},</p>
            
            <p style="font-size: 16px; line-height: 1.6;">Great news! Your YouTube channel <strong>"${data.channelTitle}"</strong> has been processed and is now ready for AI-powered conversations.</p>
            
            <div class="stats">
              <h3 style="margin: 0 0 16px 0; color: #0f172a; font-size: 18px;">Processing Summary</h3>
              <div class="stat-row">
                <span class="stat-label">Videos Successfully Indexed</span>
                <span class="stat-value success-value"> ${data.videosProcessed}</span>
              </div>
              ${data.totalVideos && data.totalVideos > 0 ? `
              <div class="stat-row">
                <span class="stat-label">Total Videos Found</span>
                <span class="stat-value"> ${data.totalVideos}</span>
              </div>
              ` : ''}
              ${data.noTranscriptVideos && data.noTranscriptVideos > 0 ? `
              <div class="stat-row">
                <span class="stat-label">No Captions Available</span>
                <span class="stat-value warning-value">${data.noTranscriptVideos}</span>
              </div>
              ` : ''}
              ${data.existingVideos && data.existingVideos > 0 ? `
              <div class="stat-row">
                <span class="stat-label">Already Indexed</span>
                <span class="stat-value info-value">${data.existingVideos}</span>
              </div>
              ` : ''}
            </div>
            
            ${data.noTranscriptVideos ? `
            <div class="warning-box">
              <strong>ℹ️ Note:</strong> ${data.noTranscriptVideos} video${data.noTranscriptVideos > 1 ? 's' : ''} couldn't be indexed because ${data.noTranscriptVideos > 1 ? 'they don\'t' : 'it doesn\'t'} have captions available. This is normal for videos without closed captions.
            </div>
            ` : ''}
            
            <p style="font-size: 16px; line-height: 1.6;">You can now chat with your YouTube channel! Ask questions, get summaries, or explore topics across all ${data.videosProcessed} indexed videos.</p>
            
            <div style="text-align: center; margin: 32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://vidsift.com'}/dashboard?tab=channels" class="button">
                Start Chatting with Your Channel
              </a>
            </div>
            
            <p style="color: #64748b; font-size: 14px; margin-top: 24px; line-height: 1.6;">
              <strong>What's next?</strong> Head to VidSift, select your indexed channel, and start asking questions about your video content. Our AI will search across all ${data.videosProcessed} indexed videos to give you comprehensive answers with precise timestamps.
            </p>
          </div>
          
          <div class="footer">
            <p style="margin: 0 0 8px 0;">Thanks for using VidSift!</p>
            <p style="margin: 0;">If you have any questions, just reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getFailureEmailContent(data) {
    // COPIED EXACTLY FROM FRONTEND
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Channel Processing Failed - VidSift</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; margin-top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); color: white; padding: 32px 24px; text-align: center; }
          .content { padding: 32px 24px; }
          .button { display: inline-block; background: #0f172a; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
          .error-box { background: #fef2f2; border: 1px solid #fecaca; padding: 16px; border-radius: 6px; margin: 16px 0; }
          .footer { background: #f8fafc; padding: 24px; text-align: center; color: #64748b; font-size: 14px; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 24px;">⚠️ Processing Failed</h1>
            <p style="margin: 8px 0 0 0; opacity: 0.9;">We encountered an issue processing your channel</p>
          </div>
          
          <div class="content">
            <p style="font-size: 16px; line-height: 1.6;">Hi ${data.userName || 'there'},</p>
            
            <p style="font-size: 16px; line-height: 1.6;">Unfortunately, we couldn't process the YouTube channel <strong>"${data.channelTitle}"</strong>.</p>
            
            <div class="error-box">
              <p style="margin: 0; font-size: 14px;">
                <strong>Error:</strong> ${data.errorMessage || 'An unexpected error occurred during processing'}
              </p>
            </div>
            
            <h3 style="margin-top: 32px; margin-bottom: 16px;">Common issues and solutions:</h3>
            <ul style="line-height: 1.8;">
              <li><strong>Invalid channel URL:</strong> Make sure you're using a valid YouTube channel URL</li>
              <li><strong>Private channel:</strong> The channel must be public for us to access it</li>
              <li><strong>Too many videos:</strong> Channels with 500+ videos may need special handling</li>
              <li><strong>API limits:</strong> We may have hit YouTube's rate limits - try again in an hour</li>
            </ul>
            
            <div style="text-align: center; margin: 32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://vidsift.com'}/dashboard?tab=channels" class="button">
                Try Another Channel
              </a>
            </div>
            
            <p style="color: #64748b; font-size: 14px; margin-top: 24px;">
              If you continue to experience issues, please reply to this email with the channel URL and we'll help you out.
            </p>
          </div>
          
          <div class="footer">
            <p style="margin: 0;">Need help? Just reply to this email and we'll assist you.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async sendWelcomeEmail(userEmail) {
    if (!this.resend) {
      console.log('📧 Email service not configured (no Resend API key)');
      return false;
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: 'VidSift <noreply@vidsift.com>',
        to: userEmail,
        subject: 'Welcome to VidSift! 🎥',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #8b5cf6;">Welcome to VidSift!</h1>
            
            <p>We're excited to have you on board! VidSift transforms how you interact with video content through AI-powered conversations.</p>
            
            <h3>Getting Started:</h3>
            <ol>
              <li><strong>Add a YouTube Channel:</strong> Paste any YouTube channel URL to start processing</li>
              <li><strong>Wait for Processing:</strong> We'll download and analyze all video transcripts</li>
              <li><strong>Start Chatting:</strong> Ask questions about any video in natural language</li>
            </ol>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h4 style="margin: 0 0 10px 0;">Pro Tips:</h4>
              <ul style="margin: 0; padding-left: 20px;">
                <li>Use timestamps to jump to specific moments</li>
                <li>Ask for summaries to get quick overviews</li>
                <li>Search across multiple videos at once</li>
              </ul>
            </div>
            
            <div style="margin: 30px 0;">
              <a href="https://vidsift.com/channels" 
                 style="background: #8b5cf6; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Start Exploring
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              Questions? Just reply to this email.<br>
              Happy watching!<br>
              The VidSift Team
            </p>
          </div>
        `
      });

      if (error) {
        console.error('Failed to send welcome email:', error);
        return false;
      }

      return true;

    } catch (error) {
      console.error('Email service error:', error);
      return false;
    }
  }
}

export const emailService = new EmailService();