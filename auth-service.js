// Updated auth-service.js for GitHub Pages deployment
// This version removes Electron-specific dependencies and focuses on web deployment

let authService = null;

// Initialize the Auth0 client
async function initializeAuth() {
    try {
        console.log('Initializing Auth0 with config:', AUTH_CONFIG);
        
        // Create the Auth0 client configuration
        const clientConfig = {
            domain: AUTH_CONFIG.domain,
            clientId: AUTH_CONFIG.clientId,
            authorizationParams: {
                redirect_uri: AUTH_CONFIG.redirectUri,
                scope: AUTH_CONFIG.scope
            },
            cacheLocation: 'localstorage',
            useRefreshTokens: true,
            httpTimeoutInSeconds: 60
        };

        // Only add audience if it's defined and not empty
        if (AUTH_CONFIG.audience && AUTH_CONFIG.audience.trim()) {
            clientConfig.authorizationParams.audience = AUTH_CONFIG.audience;
        }

        authService = await auth0.createAuth0Client(clientConfig);
        console.log('Auth0 client initialized successfully');
        return authService;
    } catch (error) {
        console.error('Failed to initialize Auth0 client:', error);
        throw new Error(`Auth0 initialization failed: ${error.message}`);
    }
}

// Authentication service methods
const authServiceMethods = {
    // Check if user is authenticated
    async isAuthenticated() {
        if (!authService) {
            console.log('Auth service not initialized, initializing now...');
            await initializeAuth();
        }

        try {
            const result = await authService.isAuthenticated();
            console.log('Authentication check result:', result);
            return result;
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
            const user = await authService.getUser();
            console.log('Retrieved user:', user);
            return user;
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
            const tokenOptions = {};
            
            // Only add audience if it's defined
            if (AUTH_CONFIG.audience && AUTH_CONFIG.audience.trim()) {
                tokenOptions.authorizationParams = {
                    audience: AUTH_CONFIG.audience
                };
            }

            return await authService.getTokenSilently(tokenOptions);
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
                scope: AUTH_CONFIG.scope
            }
        };

        // Only add audience if it's defined
        if (AUTH_CONFIG.audience && AUTH_CONFIG.audience.trim()) {
            defaultOptions.authorizationParams.audience = AUTH_CONFIG.audience;
        }

        const mergedOptions = {
            ...defaultOptions,
            ...options,
            authorizationParams: {
                ...defaultOptions.authorizationParams,
                ...options.authorizationParams
            }
        };

        console.log('Login options:', mergedOptions);

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
            console.log('Current URL:', window.location.href);
            
            const result = await authService.handleRedirectCallback();
            
            // Clear the URL parameters after successful authentication
            window.history.replaceState({}, document.title, window.location.pathname);
            
            console.log('Redirect callback processed successfully:', result);
            return result;
        } catch (error) {
            console.error('Error handling redirect callback:', error);
            console.error('Current URL parameters:', window.location.search);
            throw new Error(`Callback handling failed: ${error.message}`);
        }
    },

    // Logout
    async logout() {
        if (!authService) {
            throw new Error('Auth service not initialized');
        }

        try {
            console.log('Logging out, redirect to:', AUTH_CONFIG.logoutUri);
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
            console.log('Auth requirement check - authenticated:', isAuthenticated);

            if (!isAuthenticated) {
                // Check if we're in a callback scenario
                const urlParams = new URLSearchParams(window.location.search);
                const hasCode = urlParams.has('code');
                const hasState = urlParams.has('state');
                
                console.log('URL parameters - code:', hasCode, 'state:', hasState);

                if (hasCode && hasState) {
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
            // Show error before redirecting
            alert('Authentication error: ' + error.message);
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

console.log('Auth service loaded successfully');
