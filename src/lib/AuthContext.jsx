import React, { createContext, useState, useContext, useEffect } from "react";
import { appParams } from "@/lib/app-params";

const AuthContext = createContext();

async function readJsonResponse(res) {
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    throw new Error(data.error || data.message || "Request failed");
  }

  return data;
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null);

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);

      const mockPublicSettings = {
        id: appParams.appId,
        public_settings: {},
      };

      setAppPublicSettings(mockPublicSettings);
      await checkUserAuth();
    } catch (error) {
      console.error("Unexpected error:", error);
      setAuthError({
        type: "unknown",
        message: error.message || "An unexpected error occurred",
      });
    } finally {
      setIsLoadingPublicSettings(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);

      const res = await fetch("/api/auth/me", {
        method: "GET",
        credentials: "include",
      });

      if (res.status === 401) {
        setUser(null);
        setIsAuthenticated(false);
        setAuthError(null);
        return;
      }

      const currentUser = await readJsonResponse(res);

      setUser(currentUser);
      setIsAuthenticated(true);
      setAuthError(null);
    } catch (error) {
      console.error("User auth check failed:", error);
      setUser(null);
      setIsAuthenticated(false);
      setAuthError({
        type: "auth",
        message: error.message || "Authentication check failed",
      });
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const login = async (email, password) => {
    setAuthError(null);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    const data = await readJsonResponse(res);

    setUser(data.user);
    setIsAuthenticated(true);
    setAuthError(null);

    return data.user;
  };

  const logout = async (shouldRedirect = true) => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (error) {
      console.error("Logout failed:", error);
    }

    setUser(null);
    setIsAuthenticated(false);

    if (shouldRedirect) {
      window.location.href = "/login";
    }
  };

  const navigateToLogin = () => {
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoadingAuth,
        isLoadingPublicSettings,
        authError,
        appPublicSettings,
        login,
        logout,
        navigateToLogin,
        checkAppState,
        refreshUser: checkUserAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};