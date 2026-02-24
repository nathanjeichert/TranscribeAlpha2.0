"use client";

import React, { useEffect, useState } from 'react';
import LoginModal from './LoginModal';
import { isAuthenticated, logout, getCurrentUser } from '@/utils/auth';
import { needsAuth } from '@/lib/platform/api';

interface AuthProviderProps {
  children: React.ReactNode;
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const [isAuth, setIsAuth] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);

  useEffect(() => {
    // Tauri: skip auth entirely — no login required.
    if (!needsAuth()) {
      setIsAuth(true);
      setUser({ username: 'local', role: 'admin' });
      setIsLoading(false);
      return;
    }

    // Check authentication status on mount
    const authenticated = isAuthenticated();
    setIsAuth(authenticated);

    if (authenticated) {
      setUser(getCurrentUser());
    }

    setIsLoading(false);
  }, []);

  const handleLoginSuccess = () => {
    setIsAuth(true);
    setUser(getCurrentUser());
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

  return <>{children}</>;
}
