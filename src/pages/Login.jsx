// src/pages/Login.jsx

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Lock, Mail } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoadingAuth, authError } = useAuth();

  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!isLoadingAuth && isAuthenticated) {
      const redirectTo = location.state?.from?.pathname || "/";
      navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, isLoadingAuth, location.state, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError("");

    if (!formData.email || !formData.password) {
      setLocalError("Please enter your email and password.");
      return;
    }

    try {
      setIsSubmitting(true);
      await login(formData.email, formData.password);

      const redirectTo = location.state?.from?.pathname || "/";
      navigate(redirectTo, { replace: true });
    } catch (error) {
      setLocalError(error.message || "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-[var(--text-primary)]">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Checking session...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center p-6">
      <Card className="w-full max-w-md border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl text-[var(--text-primary)]">
            Sign in
          </CardTitle>
          <p className="text-sm text-[var(--text-secondary)]">
            Use your local account to access the application.
          </p>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label className="text-[var(--text-primary)]">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
                <Input
                  type="email"
                  autoComplete="email"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, email: e.target.value }))
                  }
                  placeholder="admin@example.com"
                  className="pl-10 bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-[var(--text-primary)]">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, password: e.target.value }))
                  }
                  placeholder="Enter your password"
                  className="pl-10 bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                  required
                />
              </div>
            </div>

            {(localError || authError?.message) && (
              <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
                {localError || authError?.message}
              </div>
            )}

            <Button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Sign in
            </Button>

            <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3 text-xs text-[var(--text-secondary)] space-y-1">
              <p>Default local accounts:</p>
              <p>Admin: admin@example.com / admin123</p>
              <p>User: user@example.com / user123</p>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}