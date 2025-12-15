"use client";

import React, { useEffect, useState } from 'react';
import LoginModal from './LoginModal';
import { isAuthenticated, initializeTokenRefresh, logout, getCurrentUser } from '@/utils/auth';

interface AuthProviderProps {
  children: React.ReactNode;
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const [isAuth, setIsAuth] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);

  useEffect(() => {
    // Check authentication status on mount
    const authenticated = isAuthenticated();
    setIsAuth(authenticated);

    if (authenticated) {
      setUser(getCurrentUser());
      // Initialize automatic token refresh
      initializeTokenRefresh();
    }

    setIsLoading(false);
  }, []);

  const handleLoginSuccess = () => {
    setIsAuth(true);
    setUser(getCurrentUser());
    initializeTokenRefresh();
  };

  const handleLogout = () => {
    logout();
    setIsAuth(false);
    setUser(null);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-primary-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary-900"></div>
          <p className="mt-4 text-primary-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuth) {
    return <LoginModal onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <>
      {/* User info bar - fixed at top */}
      <div className="sticky top-0 z-50 bg-primary-800 text-white px-4 py-2 flex justify-between items-center shadow-md">
        <div className="text-sm">
          Signed in as <span className="font-semibold">{user?.username}</span>
        </div>
        <button
          onClick={handleLogout}
          className="text-sm bg-red-600 hover:bg-red-500 px-4 py-1.5 rounded font-medium transition-colors shadow-sm"
        >
          Sign Out
        </button>
      </div>
      {children}
    </>
  );
}
