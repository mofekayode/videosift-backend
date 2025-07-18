import express from 'express';
import { supabase } from '../server.js';
import { emailService } from '../services/emailService.js';

const router = express.Router();

// Join waitlist
router.post('/join', async (req, res) => {
  try {
    const { email, name, useCase, source } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if already on waitlist
    const { data: existing } = await supabase
      .from('waitlist')
      .select('id, status')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.json({
        success: true,
        alreadyExists: true,
        status: existing.status,
        message: 'You are already on the waitlist'
      });
    }

    // Add to waitlist
    const { data: entry, error } = await supabase
      .from('waitlist')
      .insert({
        email: email.toLowerCase(),
        name: name || null,
        use_case: useCase || null,
        source: source || 'api',
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Send welcome email
    if (emailService.sendWaitlistWelcome) {
      await emailService.sendWaitlistWelcome(email, name).catch(err => {
        console.error('Failed to send waitlist email:', err);
      });
    }

    res.json({
      success: true,
      message: 'Successfully joined the waitlist',
      position: entry.id // Simple position indicator
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check waitlist status
router.get('/status', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { data: entry, error } = await supabase
      .from('waitlist')
      .select('id, status, created_at, invited_at')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !entry) {
      return res.status(404).json({ 
        error: 'Not found on waitlist',
        onWaitlist: false 
      });
    }

    // Get approximate position
    const { count: position } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')
      .lt('id', entry.id);

    res.json({
      success: true,
      onWaitlist: true,
      status: entry.status,
      joinedAt: entry.created_at,
      invitedAt: entry.invited_at,
      position: entry.status === 'pending' ? (position || 0) + 1 : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;