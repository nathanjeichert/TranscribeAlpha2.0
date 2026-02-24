/**
 * Authentication utility for TranscribeAlpha
 * Handles token storage, refresh, and API authentication.
 *
 * In Tauri desktop mode, auth is skipped entirely — all API calls go to
 * a local sidecar with no JWT required.
 */

import { logger } from '@/utils/logger'
import { isTauri } from '@/lib/platform'
import { apiUrl, needsAuth } from '@/lib/platform/api'

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
  if (!needsAuth()) return 'tauri-standalone';
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
  if (!needsAuth()) return { username: 'local', role: 'admin' };
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
  if (!needsAuth()) return true;
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
  if (!needsAuth()) return;
  try {
    const token = getAccessToken();
    if (token) {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    }
  } catch (error) {
    logger.error('Logout error:', error);
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
  if (!needsAuth()) return 'tauri-standalone';
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return null;
  }

  try {
    const response = await fetch(apiUrl('/api/auth/refresh'), {
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
    logger.error('Token refresh error:', error);
    clearAuth();
    return null;
  }
}

/**
 * Make an authenticated API request with automatic token refresh.
 * In Tauri mode, no Authorization header is sent.
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const fullUrl = apiUrl(url)

  // Tauri: no auth needed, just fetch with the correct base URL.
  if (!needsAuth()) {
    return fetch(fullUrl, options)
  }

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
  let response = await fetch(fullUrl, requestOptions);

  // If unauthorized, try to refresh the token and retry once
  if (response.status === 401) {
    token = await refreshAccessToken();

    if (token) {
      // Retry with new token
      headers.set('Authorization', `Bearer ${token}`);
      response = await fetch(fullUrl, requestOptions);
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
  if (!needsAuth()) return {};
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
  if (!needsAuth()) return false;
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

