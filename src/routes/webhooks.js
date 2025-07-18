import express from 'express';
import { Webhook } from 'svix';
import { supabase } from '../server.js';
import { emailService } from '../services/emailService.js';

const router = express.Router();

// Clerk webhook handler
router.post('/clerk', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify the webhook signature
    const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
    
    if (!WEBHOOK_SECRET) {
      console.error('❌ CLERK_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Get the headers
    const svix_id = req.headers['svix-id'];
    const svix_timestamp = req.headers['svix-timestamp'];
    const svix_signature = req.headers['svix-signature'];

    // If there are no headers, error out
    if (!svix_id || !svix_timestamp || !svix_signature) {
      return res.status(400).json({ error: 'Missing svix headers' });
    }

    // Create a new Svix instance with your webhook secret
    const wh = new Webhook(WEBHOOK_SECRET);

    let evt;

    // Verify the payload with the headers
    try {
      evt = wh.verify(req.body, {
        'svix-id': svix_id,
        'svix-timestamp': svix_timestamp,
        'svix-signature': svix_signature,
      });
    } catch (err) {
      console.error('❌ Webhook verification failed:', err);
      return res.status(400).json({ error: 'Webhook verification failed' });
    }

    // Handle the webhook event
    const eventType = evt.type;
    console.log(`📨 Clerk webhook received: ${eventType}`);

    switch (eventType) {
      case 'user.created':
        await handleUserCreated(evt.data);
        break;
        
      case 'user.updated':
        await handleUserUpdated(evt.data);
        break;
        
      case 'user.deleted':
        await handleUserDeleted(evt.data);
        break;
        
      case 'session.created':
        console.log('👤 New session created:', evt.data.user_id);
        break;
        
      default:
        console.log(`⚠️ Unhandled webhook event: ${eventType}`);
    }

    res.json({ success: true, received: eventType });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Handle user created event
async function handleUserCreated(userData) {
  try {
    console.log('👤 Creating user:', userData.email_addresses?.[0]?.email_address);
    
    const email = userData.email_addresses?.[0]?.email_address;
    const firstName = userData.first_name;
    const lastName = userData.last_name;
    
    if (!email) {
      console.error('❌ No email found for user');
      return;
    }

    // Create user in database
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        clerk_id: userData.id,
        email: email,
        first_name: firstName,
        last_name: lastName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating user:', error);
      return;
    }

    console.log('✅ User created:', user.id);

    // Send welcome email
    await emailService.sendWelcomeEmail(email, firstName || email.split('@')[0])
      .catch(err => console.error('Failed to send welcome email:', err));

  } catch (error) {
    console.error('❌ Error in handleUserCreated:', error);
  }
}

// Handle user updated event
async function handleUserUpdated(userData) {
  try {
    console.log('👤 Updating user:', userData.id);
    
    const email = userData.email_addresses?.[0]?.email_address;
    const firstName = userData.first_name;
    const lastName = userData.last_name;

    // Update user in database
    const { error } = await supabase
      .from('users')
      .update({
        email: email,
        first_name: firstName,
        last_name: lastName,
        updated_at: new Date().toISOString()
      })
      .eq('clerk_id', userData.id);

    if (error) {
      console.error('❌ Error updating user:', error);
      return;
    }

    console.log('✅ User updated');

  } catch (error) {
    console.error('❌ Error in handleUserUpdated:', error);
  }
}

// Handle user deleted event
async function handleUserDeleted(userData) {
  try {
    console.log('👤 Deleting user:', userData.id);
    
    // Soft delete - just mark as deleted
    const { error } = await supabase
      .from('users')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('clerk_id', userData.id);

    if (error) {
      console.error('❌ Error deleting user:', error);
      return;
    }

    console.log('✅ User marked as deleted');

  } catch (error) {
    console.error('❌ Error in handleUserDeleted:', error);
  }
}

export default router;