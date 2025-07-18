// Simple auth middleware - you can enhance this with JWT or other methods
export const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.BACKEND_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Get user info from headers (passed by frontend)
  const userId = req.headers['x-user-id'];
  const userEmail = req.headers['x-user-email'];
  
  req.user = { 
    id: userId || 'api-client', 
    email: userEmail,
    isApiKey: true 
  };
  
  next();
};