const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// JWT secret (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'sierra-sync-secret-key-2024';
const JWT_EXPIRES_IN = '24h';
const REFRESH_TOKEN_EXPIRES_IN = '7d';

// Demo users database (in production, use real database)
const users = [
  {
    id: 1,
    email: 'demo@sierrasync.com',
    password: '$2a$10$8K.Q9Dw8VKWvR1YX6dCTUe9vKpM.nYzE4Rb5tPxYmKUCxGz6Jd.KS', // demo123
    name: 'Demo User',
    role: 'operations',
    dashboard: 'main-dashboard.html',
    permissions: ['read:leads', 'read:sync_status', 'write:manual_sync'],
    company: 'Demo Real Estate',
    avatar: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastLogin: null,
    isActive: true
  },
  {
    id: 2,
    email: 'admin@sierrasync.com',
    password: '$2a$10$rFzPjX3dXqW9kY2QmZ8XL.HLQm5V4bE8sQ3pR7yT6mA2nB9cF1eE2', // admin123
    name: 'Admin User',
    role: 'admin',
    dashboard: 'dashboard.html',
    permissions: ['*'], // All permissions
    company: 'Sierra Sync Inc',
    avatar: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastLogin: null,
    isActive: true
  },
  {
    id: 3,
    email: 'analytics@sierrasync.com',
    password: '$2a$10$mN4oP2qR8sT7vU9wX6yZ5A.CrDd6hE4fG9iJ5kL2mN8oP3qR4sT7v', // analytics123
    name: 'Analytics User',
    role: 'analytics',
    dashboard: 'analytics-dashboard.html',
    permissions: ['read:analytics', 'read:reports', 'write:export'],
    company: 'Analytics Corp',
    avatar: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastLogin: null,
    isActive: true
  }
];

// Active sessions store (in production, use Redis)
const activeSessions = new Map();

// Helper functions
function generateTokens(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    permissions: user.permissions
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const refreshToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN });

  return { accessToken, refreshToken };
}

function getUserById(id) {
  return users.find(user => user.id === id && user.isActive);
}

function getUserByEmail(email) {
  return users.find(user => user.email === email && user.isActive);
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    req.user = payload;
    next();
  });
}

// Role-based authorization middleware
function authorize(roles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (roles.length && !roles.includes(req.user.role) && !req.user.permissions.includes('*')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

// Routes

// POST /auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password, remember = false } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Find user
    const user = getUserByEmail(email.toLowerCase());
    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Update last login
    user.lastLogin = new Date().toISOString();

    // Store session
    const sessionId = `${user.id}_${Date.now()}`;
    activeSessions.set(sessionId, {
      userId: user.id,
      accessToken,
      refreshToken,
      createdAt: new Date(),
      remember,
      userAgent: req.headers['user-agent'],
      ip: req.ip
    });

    // Response
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        dashboard: user.dashboard,
        permissions: user.permissions,
        company: user.company,
        avatar: user.avatar,
        lastLogin: user.lastLogin
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: JWT_EXPIRES_IN
      },
      sessionId
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: 'Refresh token required'
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    const user = getUserById(decoded.id);

    if (!user) {
      return res.status(401).json({
        error: 'Invalid refresh token'
      });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

    res.json({
      success: true,
      tokens: {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: JWT_EXPIRES_IN
      }
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(401).json({
      error: 'Invalid refresh token'
    });
  }
});

// POST /auth/logout
router.post('/logout', authenticateToken, (req, res) => {
  try {
    const { sessionId } = req.body;

    // Remove session
    if (sessionId) {
      activeSessions.delete(sessionId);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// GET /auth/me
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = getUserById(req.user.id);

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        dashboard: user.dashboard,
        permissions: user.permissions,
        company: user.company,
        avatar: user.avatar,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// POST /auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters long'
      });
    }

    const user = getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(400).json({
        error: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email is required'
      });
    }

    const user = getUserByEmail(email.toLowerCase());
    
    // Always return success for security (don't reveal if email exists)
    res.json({
      success: true,
      message: 'If an account exists with this email, password reset instructions have been sent.'
    });

    // In a real app, send reset email here
    if (user) {
      console.log(`Password reset requested for user: ${user.email}`);
      // Generate reset token and send email
    }

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// GET /auth/sessions
router.get('/sessions', authenticateToken, (req, res) => {
  try {
    const userSessions = [];
    
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.userId === req.user.id) {
        userSessions.push({
          sessionId,
          createdAt: session.createdAt,
          userAgent: session.userAgent,
          ip: session.ip,
          remember: session.remember
        });
      }
    }

    res.json({
      success: true,
      sessions: userSessions
    });

  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// DELETE /auth/sessions/:sessionId
router.delete('/sessions/:sessionId', authenticateToken, (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    activeSessions.delete(sessionId);

    res.json({
      success: true,
      message: 'Session terminated successfully'
    });

  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Export middleware for use in other routes
module.exports = {
  router,
  authenticateToken,
  authorize,
  users
};