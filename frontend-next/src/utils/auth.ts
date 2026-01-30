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

interface MediaTokenResponse {
  token?: string;
  expires_in?: number;
  expires_at?: string;
}

const MEDIA_TOKEN_REFRESH_BUFFER_MS = 10 * 1000
let cachedMediaToken: { token: string; expiresAt: number } | null = null
let mediaTokenPromise: Promise<string | null> | null = null

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
  cachedMediaToken = null
  mediaTokenPromise = null
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
 * Append the current access token to media URLs that can't send headers.
 */
export function appendAccessTokenToMediaUrl(url: string): string {
  if (!url || !url.includes('/api/media/')) {
    return url;
  }
  if (url.includes('token=')) {
    return url;
  }
  const token = getAccessToken();
  if (!token) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * Fetch a short-lived media token for protected media URLs.
 */
export async function getMediaToken(forceRefresh = false): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const now = Date.now()
  if (!forceRefresh && cachedMediaToken && cachedMediaToken.expiresAt - MEDIA_TOKEN_REFRESH_BUFFER_MS > now) {
    return cachedMediaToken.token
  }
  if (!forceRefresh && mediaTokenPromise) {
    return mediaTokenPromise
  }

  mediaTokenPromise = (async () => {
    try {
      const response = await authenticatedFetch('/api/media-token', { method: 'POST' })
      if (!response.ok) {
        return null
      }
      const data: MediaTokenResponse = await response.json().catch(() => ({}))
      if (!data.token) {
        return null
      }
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 300
      cachedMediaToken = {
        token: data.token,
        expiresAt: now + expiresIn * 1000,
      }
      return data.token
    } catch {
      return null
    } finally {
      mediaTokenPromise = null
    }
  })()

  return mediaTokenPromise
}

/**
 * Build a media URL with a short-lived token.
 */
export async function buildMediaUrl(url: string, forceRefresh = false): Promise<string> {
  if (!url || !url.includes('/api/media/')) {
    return url
  }
  const token = await getMediaToken(forceRefresh)
  if (!token) {
    return url
  }
  if (url.includes('token=')) {
    return url
  }
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}token=${encodeURIComponent(token)}`
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
