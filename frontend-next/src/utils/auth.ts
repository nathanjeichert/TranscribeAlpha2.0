/**
 * Authentication utility for TranscribeAlpha
 * Handles token storage, refresh, and API authentication
 */

export interface User {
  username: string;
  role: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * Get the current access token from localStorage
 */
export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('access_token');
}

/**
 * Get the current refresh token from localStorage
 */
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('refresh_token');
}

/**
 * Get the current user from localStorage
 */
export function getCurrentUser(): User | null {
  if (typeof window === 'undefined') return null;
  const userStr = localStorage.getItem('user');
  if (!userStr) return null;
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

/**
 * Clear all authentication data
 */
export function clearAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user');
}

/**
 * Logout the current user
 */
export async function logout(): Promise<void> {
  try {
    const token = getAccessToken();
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    }
  } catch (error) {
    console.error('Logout error:', error);
  } finally {
    clearAuth();
    // Reload the page to show login screen
    window.location.reload();
  }
}

/**
 * Refresh the access token using the refresh token
 */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return null;
  }

  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      clearAuth();
      return null;
    }

    const data = await response.json();
    localStorage.setItem('access_token', data.access_token);
    return data.access_token;
  } catch (error) {
    console.error('Token refresh error:', error);
    clearAuth();
    return null;
  }
}

/**
 * Make an authenticated API request with automatic token refresh
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  let token = getAccessToken();

  if (!token) {
    throw new Error('No access token available');
  }

  // Add Authorization header
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const requestOptions: RequestInit = {
    ...options,
    headers,
  };

  // Make the request
  let response = await fetch(url, requestOptions);

  // If unauthorized, try to refresh the token and retry once
  if (response.status === 401) {
    console.log('Access token expired, refreshing...');
    token = await refreshAccessToken();

    if (token) {
      // Retry with new token
      headers.set('Authorization', `Bearer ${token}`);
      response = await fetch(url, requestOptions);
    } else {
      // Refresh failed, redirect to login
      clearAuth();
      window.location.reload();
      throw new Error('Authentication failed');
    }
  }

  return response;
}

/**
 * Add Authorization header to fetch options
 * This is a simpler helper for when you want to handle the response yourself
 */
export function getAuthHeaders(): HeadersInit {
  const token = getAccessToken();
  if (!token) {
    return {};
  }
  return {
    'Authorization': `Bearer ${token}`,
  };
}

/**
 * Check if the access token is expired
 */
export function isTokenExpired(): boolean {
  const token = getAccessToken();
  if (!token) return true;

  try {
    // Decode JWT payload (simple base64 decode, not cryptographic verification)
    const payload = JSON.parse(atob(token.split('.')[1]));
    const exp = payload.exp;

    if (!exp) return true;

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000);
    return now >= exp;
  } catch {
    return true;
  }
}

/**
 * Initialize authentication (no automatic refresh needed - tokens last 1 year)
 * Users stay logged in until they explicitly log out
 */
export function initializeTokenRefresh(): void {
  // Tokens now last 1 year, so no automatic refresh is needed
  // Users will stay logged in until they explicitly log out
  // This function is kept for API compatibility
}
