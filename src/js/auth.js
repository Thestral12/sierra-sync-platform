/**
 * Sierra Sync Authentication Library
 * Handles user authentication, session management, and role-based access control
 */

class SierraSyncAuth {
    constructor() {
        this.apiBaseUrl = 'http://localhost:9146/api';
        this.sessionKey = 'sierraSync_session';
        this.tokenKey = 'sierraSync_token';
        this.refreshTokenKey = 'sierraSync_refresh_token';
        
        // Role-based dashboard mappings
        this.dashboards = {
            'operations': 'main-dashboard.html',
            'admin': 'dashboard.html',
            'analytics': 'analytics-dashboard.html'
        };

        // Initialize auth state
        this.currentUser = null;
        this.isAuthenticated = false;
        
        // Check existing session on initialization - this is synchronous
        this.initializeSession();
    }
    
    /**
     * Initialize session from storage (synchronous)
     */
    initializeSession() {
        try {
            const sessionData = this.getStoredSession();
            
            if (sessionData) {
                this.currentUser = {
                    id: sessionData.id,
                    email: sessionData.email,
                    name: sessionData.name,
                    role: sessionData.role,
                    dashboard: sessionData.dashboard
                };
                this.isAuthenticated = true;
                console.log('Session initialized:', this.currentUser);
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Session initialization error:', error);
            this.clearSession();
            return false;
        }
    }

    /**
     * Login user with email and password
     */
    async login(email, password, remember = false) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password, remember })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Login failed');
            }

            // Store tokens and session
            this.storeTokens(data.tokens, remember);
            this.storeSession(data.user, data.sessionId, remember);
            
            // Update auth state
            this.currentUser = data.user;
            this.isAuthenticated = true;

            return {
                success: true,
                user: data.user,
                redirectUrl: this.getDashboardUrl(data.user.role)
            };

        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    }

    /**
     * Logout current user
     */
    async logout() {
        try {
            const sessionData = this.getStoredSession();
            
            if (sessionData && sessionData.sessionId) {
                // Call logout API
                await fetch(`${this.apiBaseUrl}/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.getStoredToken()}`
                    },
                    body: JSON.stringify({ sessionId: sessionData.sessionId })
                });
            }
        } catch (error) {
            console.error('Logout API error:', error);
            // Continue with local cleanup even if API call fails
        }

        // Clear local storage
        this.clearSession();
        
        // Update auth state
        this.currentUser = null;
        this.isAuthenticated = false;

        // Redirect to login
        window.location.href = 'login.html';
    }

    /**
     * Register new user
     */
    async register(userData) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(userData)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Registration failed');
            }

            return {
                success: true,
                user: data.user,
                message: 'Registration successful! Please check your email to verify your account.'
            };

        } catch (error) {
            console.error('Registration error:', error);
            throw error;
        }
    }

    /**
     * Get current user information
     */
    async getCurrentUser() {
        try {
            // For demo, return the session data as user
            const sessionData = this.getStoredSession();
            
            if (sessionData) {
                const user = {
                    id: sessionData.id,
                    email: sessionData.email,
                    name: sessionData.name,
                    role: sessionData.role,
                    dashboard: sessionData.dashboard,
                    company: 'Demo Company',
                    lastLogin: sessionData.loginTime
                };
                
                this.currentUser = user;
                this.isAuthenticated = true;
                return user;
            }
            
            // If we have a token but no session, try API
            const token = this.getStoredToken();
            if (!token) {
                throw new Error('No access token found');
            }

            const response = await fetch(`${this.apiBaseUrl}/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to get user info');
            }

            // Update current user
            this.currentUser = data.user;
            this.isAuthenticated = true;

            return data.user;

        } catch (error) {
            console.error('Get current user error:', error);
            // Don't clear session for demo mode
            if (this.currentUser) {
                return this.currentUser;
            }
            throw error;
        }
    }

    /**
     * Refresh access token
     */
    async refreshToken() {
        try {
            const refreshToken = this.getStoredRefreshToken();
            if (!refreshToken) {
                throw new Error('No refresh token found');
            }

            const response = await fetch(`${this.apiBaseUrl}/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ refreshToken })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Token refresh failed');
            }

            // Store new tokens
            const sessionData = this.getStoredSession();
            const remember = sessionData ? sessionData.remember : false;
            this.storeTokens(data.tokens, remember);

            return data.tokens.accessToken;

        } catch (error) {
            console.error('Token refresh error:', error);
            this.clearSession();
            throw error;
        }
    }

    /**
     * Change user password
     */
    async changePassword(currentPassword, newPassword) {
        try {
            const token = this.getStoredToken();
            if (!token) {
                throw new Error('Authentication required');
            }

            const response = await fetch(`${this.apiBaseUrl}/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ currentPassword, newPassword })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Password change failed');
            }

            return {
                success: true,
                message: 'Password changed successfully'
            };

        } catch (error) {
            console.error('Change password error:', error);
            throw error;
        }
    }

    /**
     * Request password reset
     */
    async forgotPassword(email) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/auth/forgot-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Password reset failed');
            }

            return {
                success: true,
                message: data.message
            };

        } catch (error) {
            console.error('Forgot password error:', error);
            throw error;
        }
    }

    /**
     * Check if user is authenticated and has valid session
     */
    checkSession() {
        // Just re-initialize the session
        return this.initializeSession();
    }

    /**
     * Require authentication - redirect to login if not authenticated
     */
    requireAuth() {
        if (!this.isAuthenticated) {
            this.redirectToLogin();
            return false;
        }
        return true;
    }

    /**
     * Check if user has required role
     */
    hasRole(requiredRole) {
        if (!this.isAuthenticated || !this.currentUser) {
            return false;
        }

        if (Array.isArray(requiredRole)) {
            return requiredRole.includes(this.currentUser.role);
        }

        return this.currentUser.role === requiredRole;
    }

    /**
     * Require specific role - redirect if user doesn't have it
     */
    requireRole(requiredRole) {
        if (!this.requireAuth()) {
            return false;
        }

        if (!this.hasRole(requiredRole)) {
            this.redirectToDashboard();
            return false;
        }

        return true;
    }

    /**
     * Get dashboard URL for user role
     */
    getDashboardUrl(role) {
        return this.dashboards[role] || 'main-dashboard.html';
    }

    /**
     * Redirect to appropriate dashboard based on user role
     */
    redirectToDashboard() {
        if (this.currentUser && this.currentUser.role) {
            window.location.href = this.getDashboardUrl(this.currentUser.role);
        } else {
            window.location.href = 'main-dashboard.html';
        }
    }

    /**
     * Redirect to login page
     */
    redirectToLogin() {
        const currentUrl = window.location.href;
        const loginUrl = 'login.html?from=redirect';
        
        // Don't redirect if already on login/register pages
        if (currentUrl.includes('login.html') || currentUrl.includes('register.html')) {
            return;
        }

        // Clear sessions to prevent loops
        this.clearSession();
        
        window.location.href = loginUrl;
    }

    /**
     * Store authentication tokens
     */
    storeTokens(tokens, remember = false) {
        const storage = remember ? localStorage : sessionStorage;
        storage.setItem(this.tokenKey, tokens.accessToken);
        
        if (tokens.refreshToken) {
            storage.setItem(this.refreshTokenKey, tokens.refreshToken);
        }
    }

    /**
     * Store session data
     */
    storeSession(user, sessionId, remember = false) {
        const storage = remember ? localStorage : sessionStorage;
        const sessionData = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            dashboard: user.dashboard,
            sessionId: sessionId,
            remember: remember,
            loginTime: new Date().toISOString()
        };
        
        storage.setItem(this.sessionKey, JSON.stringify(sessionData));
    }

    /**
     * Get stored session data
     */
    getStoredSession() {
        try {
            const localSession = localStorage.getItem(this.sessionKey);
            const sessionSession = sessionStorage.getItem(this.sessionKey);
            
            const sessionData = localSession || sessionSession;
            return sessionData ? JSON.parse(sessionData) : null;
        } catch (error) {
            console.error('Error getting stored session:', error);
            return null;
        }
    }

    /**
     * Get stored access token
     */
    getStoredToken() {
        return localStorage.getItem(this.tokenKey) || sessionStorage.getItem(this.tokenKey);
    }

    /**
     * Get stored refresh token
     */
    getStoredRefreshToken() {
        return localStorage.getItem(this.refreshTokenKey) || sessionStorage.getItem(this.refreshTokenKey);
    }

    /**
     * Clear all stored session data
     */
    clearSession() {
        // Clear from both storages
        [localStorage, sessionStorage].forEach(storage => {
            storage.removeItem(this.sessionKey);
            storage.removeItem(this.tokenKey);
            storage.removeItem(this.refreshTokenKey);
        });
    }

    /**
     * Make authenticated API request
     */
    async apiRequest(url, options = {}) {
        let token = this.getStoredToken();
        
        if (!token) {
            throw new Error('No access token available');
        }

        // Add authorization header
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
            'Authorization': `Bearer ${token}`
        };

        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            // If token is expired, try to refresh
            if (response.status === 401) {
                try {
                    token = await this.refreshToken();
                    
                    // Retry request with new token
                    return await fetch(url, {
                        ...options,
                        headers: {
                            ...headers,
                            'Authorization': `Bearer ${token}`
                        }
                    });
                } catch (refreshError) {
                    this.redirectToLogin();
                    throw refreshError;
                }
            }

            return response;
        } catch (error) {
            console.error('API request error:', error);
            throw error;
        }
    }

    /**
     * Demo login for development/testing
     */
    async demoLogin(role = 'operations') {
        const demoCredentials = {
            'operations': { email: 'demo@sierrasync.com', password: 'demo123' },
            'admin': { email: 'admin@sierrasync.com', password: 'admin123' },
            'analytics': { email: 'analytics@sierrasync.com', password: 'analytics123' }
        };

        const creds = demoCredentials[role];
        if (!creds) {
            throw new Error('Invalid demo role');
        }

        return await this.login(creds.email, creds.password, false);
    }
}

// Create global auth instance
window.SierraSyncAuth = SierraSyncAuth;
window.auth = new SierraSyncAuth();

// Utility functions for backward compatibility
window.checkAuth = () => auth.requireAuth();
window.checkRole = (role) => auth.requireRole(role);
window.logout = () => auth.logout();
window.getCurrentUser = () => auth.currentUser;

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SierraSyncAuth;
}