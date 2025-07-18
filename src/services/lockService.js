import { supabase } from '../server.js';

class DistributedLockService {
  constructor() {
    this.locks = new Map();
    this.lockTimers = new Map();
  }

  async acquire(resourceId, ttlSeconds = 300) {
    const lockId = `${resourceId}-${Date.now()}-${Math.random()}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    try {
      // Try to acquire lock
      const { data, error } = await supabase
        .from('processing_locks')
        .insert({
          resource_id: resourceId,
          lock_id: lockId,
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        // Check if it's a unique constraint violation
        if (error.code === '23505') {
          // Lock already exists, check if it's expired
          const existingLock = await this.checkAndCleanExpiredLock(resourceId);
          
          if (existingLock) {
            // Try again after cleaning expired lock
            return this.acquire(resourceId, ttlSeconds);
          }
          
          return null; // Lock is held by another process
        }
        throw error;
      }

      // Store lock info locally
      this.locks.set(resourceId, lockId);

      // Set up auto-release timer
      const timer = setTimeout(() => {
        this.release(resourceId).catch(err => {
          console.error(`Failed to auto-release lock ${resourceId}:`, err);
        });
      }, (ttlSeconds - 10) * 1000); // Release 10 seconds before expiry

      this.lockTimers.set(resourceId, timer);

      return lockId;
    } catch (error) {
      console.error('Error acquiring lock:', error);
      return null;
    }
  }

  async release(resourceId) {
    const lockId = this.locks.get(resourceId);
    if (!lockId) {
      return false;
    }

    try {
      // Delete the lock
      const { error } = await supabase
        .from('processing_locks')
        .delete()
        .eq('resource_id', resourceId)
        .eq('lock_id', lockId);

      if (error) {
        console.error('Error releasing lock:', error);
        return false;
      }

      // Clean up local state
      this.locks.delete(resourceId);
      
      const timer = this.lockTimers.get(resourceId);
      if (timer) {
        clearTimeout(timer);
        this.lockTimers.delete(resourceId);
      }

      return true;
    } catch (error) {
      console.error('Error releasing lock:', error);
      return false;
    }
  }

  async checkAndCleanExpiredLock(resourceId) {
    try {
      // Get the existing lock
      const { data: existingLock, error } = await supabase
        .from('processing_locks')
        .select('*')
        .eq('resource_id', resourceId)
        .single();

      if (error || !existingLock) {
        return null;
      }

      // Check if it's expired
      const now = new Date();
      const expiresAt = new Date(existingLock.expires_at);

      if (expiresAt < now) {
        // Lock is expired, clean it up
        await supabase
          .from('processing_locks')
          .delete()
          .eq('resource_id', resourceId)
          .eq('lock_id', existingLock.lock_id);

        return true; // Cleaned up expired lock
      }

      return false; // Lock is still valid
    } catch (error) {
      console.error('Error checking expired lock:', error);
      return false;
    }
  }

  async cleanupExpiredLocks() {
    try {
      const { error } = await supabase
        .from('processing_locks')
        .delete()
        .lt('expires_at', new Date().toISOString());

      if (error) {
        console.error('Error cleaning up expired locks:', error);
      }
    } catch (error) {
      console.error('Error in cleanup:', error);
    }
  }

  async isLocked(resourceId) {
    try {
      const { data: lock, error } = await supabase
        .from('processing_locks')
        .select('expires_at')
        .eq('resource_id', resourceId)
        .single();

      if (error || !lock) {
        return false;
      }

      // Check if lock is still valid
      const expiresAt = new Date(lock.expires_at);
      return expiresAt > new Date();
    } catch (error) {
      console.error('Error checking lock status:', error);
      return false;
    }
  }

  // Clean up all locks held by this instance
  async releaseAll() {
    const promises = [];
    
    for (const resourceId of this.locks.keys()) {
      promises.push(this.release(resourceId));
    }

    await Promise.all(promises);
  }
}

export const lockService = new DistributedLockService();

// Cleanup expired locks periodically
setInterval(() => {
  lockService.cleanupExpiredLocks().catch(err => {
    console.error('Lock cleanup error:', err);
  });
}, 60000); // Every minute

// Cleanup on process exit
process.on('SIGINT', async () => {
  console.log('Releasing all locks before exit...');
  await lockService.releaseAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Releasing all locks before exit...');
  await lockService.releaseAll();
  process.exit(0);
});