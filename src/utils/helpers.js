// Helper functions for the backend service

export function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

export function sanitizeYouTubeId(id) {
  // Remove any URL parameters or special characters
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function truncateText(text, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function extractVideoIdFromUrl(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

export function extractChannelIdFromUrl(url) {
  const patterns = [
    /youtube\.com\/channel\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/c\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/@([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]{24})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

export function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  return async (...args) => {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn(...args);
      } catch (error) {
        lastError = error;
        
        // Check if error is retryable
        if (error.status === 429 || error.message?.includes('rate limit')) {
          const delayMs = initialDelay * Math.pow(2, i);
          console.log(`Retry ${i + 1}/${maxRetries} after ${delayMs}ms delay`);
          await delay(delayMs);
        } else {
          throw error;
        }
      }
    }
    
    throw lastError;
  };
}

export function parseErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  if (error.error?.message) return error.error.message;
  return 'An unknown error occurred';
}