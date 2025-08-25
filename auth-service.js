// Auth0 Service for Looper App - ENHANCED VERSION
// Handles all authentication operations with improved error handling

let authService = null;

// Initialize the Auth0 client
async function initializeAuth() {
    try {
        console.log('Initializing Auth0 with config:', AUTH_CONFIG);

        authService = await auth0.createAuth0Client({
            domain: AUTH_CONFIG.domain,
            clientId: AUTH_CONFIG.clientId,
            authorizationParams: {
                redirect_uri: AUTH_CONFIG.redirectUri,
                audience: AUTH_CONFIG.audience,
                scope: AUTH_CONFIG.scope
            },
            cacheLocation: 'localstorage',
            useRefreshTokens: true,
            // Add error handling for network issues
            httpTimeoutInSeconds: 60
        });

        console.log('Auth0 client initialized successfully');
        return authService;
    } catch (error) {
        console.error('Failed to initialize Auth0 client:', error);
        throw new Error(`Auth0 initialization failed: ${error.message}`);
    }
}

// Authentication service object
const authServiceMethods = {
    // Check if user is authenticated
    async isAuthenticated() {
        if (!authService) {
            console.log('Auth service not initialized, initializing now...');
            await initializeAuth();
        }

        try {
            return await authService.isAuthenticated();
        } catch (error) {
            console.error('Authentication check failed:', error);
            return false;
        }
    },

    // Get current user
    async getUser() {
        if (!authService) {
            throw new Error('Auth service not initialized');
        }

        try {
            return await authService.getUser();
        } catch (error) {
            console.error('Get user failed:', error);
            throw error;
        }
    },

    // Get access token
    async getTokenSilently() {
        if (!authService) {
            throw new Error('Auth service not initialized');
        }

        try {
            return await authService.getTokenSilently();
        } catch (error) {
            console.error('Error getting token silently:', error);
            throw error;
        }
    },

    // Login with redirect
    async loginWithRedirect(options = {}) {
        if (!authService) {
            await initializeAuth();
        }

        const defaultOptions = {
            authorizationParams: {
                redirect_uri: AUTH_CONFIG.redirectUri,
                scope: AUTH_CONFIG.scope,
                audience: AUTH_CONFIG.audience
            }
        };

        // DEBUG: Log what we're sending to Auth0
        console.log('Auth0 login config:', {
            domain: AUTH_CONFIG.domain,
            clientId: AUTH_CONFIG.clientId,
            redirectUri: AUTH_CONFIG.redirectUri,
            audience: AUTH_CONFIG.audience
        });

        const mergedOptions = {
            ...defaultOptions,
            ...options,
            authorizationParams: {
                ...defaultOptions.authorizationParams,
                ...options.authorizationParams
            }
        };

        console.log('Final login options:', mergedOptions);

        try {
            return await authService.loginWithRedirect(mergedOptions);
        } catch (error) {
            console.error('Login redirect failed:', error);
            throw new Error(`Login failed: ${error.message}`);
        }
    },

    // Handle redirect callback
    async handleRedirectCallback() {
        if (!authService) {
            await initializeAuth();
        }

        try {
            console.log('Processing redirect callback...');
            const result = await authService.handleRedirectCallback();

            // Clear the URL parameters after successful authentication
            window.history.replaceState({}, document.title, window.location.pathname);

            console.log('Redirect callback processed successfully');
            return result;
        } catch (error) {
            console.error('Error handling redirect callback:', error);
            throw new Error(`Callback handling failed: ${error.message}`);
        }
    },

    // Logout
    async logout() {
        if (!authService) {
            throw new Error('Auth service not initialized');
        }

        try {
            return authService.logout({
                logoutParams: {
                    returnTo: AUTH_CONFIG.logoutUri
                }
            });
        } catch (error) {
            console.error('Logout failed:', error);
            throw error;
        }
    },

    // Check authentication status and redirect if needed
    async requireAuth() {
        try {
            if (!authService) {
                await initializeAuth();
            }

            const isAuthenticated = await this.isAuthenticated();
            if (!isAuthenticated) {
                // Check if we're in a callback scenario
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.has('code') && urlParams.has('state')) {
                    // We're in a callback, handle it
                    console.log('Callback detected, processing...');
                    await this.handleRedirectCallback();
                    return await this.isAuthenticated();
                } else {
                    // Redirect to login
                    console.log('Not authenticated, redirecting to login...');
                    window.location.href = 'login.html';
                    return false;
                }
            }

            return true;
        } catch (error) {
            console.error('Auth requirement check failed:', error);
            window.location.href = 'login.html';
            return false;
        }
    }
};

// Make methods available globally
window.authService = authServiceMethods;

// Also expose individual methods for backward compatibility
Object.keys(authServiceMethods).forEach(method => {
    window[method] = authServiceMethods[method];
});