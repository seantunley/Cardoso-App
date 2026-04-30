// src/pages/Login.jsx

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { reportClientError } from "@/lib/clientLog";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoadingAuth, authError } = useAuth();

  const [formData, setFormData] = useState({ email: "", password: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    fetch("/api/app-info")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.version) setAppVersion(d.version); })
      .catch(err => reportClientError("Login.appInfo", err));
  }, []);

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
      setLocalError("Credentials required.");
      return;
    }
    try {
      setIsSubmitting(true);
      const user = await login(formData.email, formData.password);
      if (!user) return;
      const redirectTo = location.state?.from?.pathname || "/";
      navigate(redirectTo, { replace: true });
    } catch (error) {
      setLocalError(error.message || "Authentication failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Verifying session
          </span>
        </div>
      </div>
    );
  }

  const displayError = localError || authError?.message;

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background text-foreground overflow-hidden">
      {/* ── Left: editorial statement ── */}
      <div className="relative hidden lg:flex lg:flex-1 flex-col justify-between p-16 overflow-hidden border-r border-border">
        {/* Ambient phosphor wash */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 20% 10%, hsla(33, 95%, 55%, 0.08) 0%, transparent 50%), radial-gradient(circle at 80% 90%, hsla(33, 95%, 55%, 0.04) 0%, transparent 50%)",
          }}
        />
        {/* Hairline grid */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(to right, hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />

        {/* Top mark */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-6 h-6 bg-accent" style={{ boxShadow: "0 0 28px hsla(33,95%,55%,0.6)" }} />
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Cardoso / Ledger System
          </span>
        </div>

        {/* Hero quote */}
        <div className="relative z-10 max-w-xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-8">
            § 01 · Access
          </div>
          <h1 className="font-display text-6xl xl:text-7xl leading-[0.95] tracking-tight">
            Every <em className="text-phosphor">rand</em>,
            <br />
            every reconciliation,
            <br />
            on the record.
          </h1>
          <p className="mt-10 text-sm text-muted-foreground max-w-md leading-relaxed">
            One platform for customer accounts, BAT reconciliation,
            inventory, printable reports and multi-site hub aggregation.
            Quietly precise. Never guessing.
          </p>
        </div>

        {/* Bottom meta */}
        <div className="relative z-10 flex items-end justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          <span>© 2026 Cardoso</span>
          <span>Johannesburg / ZA</span>
        </div>
      </div>

      {/* ── Right: the terminal ── */}
      <div className="flex-1 lg:flex-none lg:w-[480px] flex flex-col justify-center px-6 py-16 lg:px-16 relative">
        {/* Mobile mark */}
        <div className="lg:hidden mb-12 flex items-center gap-3">
          <div className="w-5 h-5 bg-accent" />
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Cardoso / Ledger
          </span>
        </div>

        <div className="max-w-sm w-full">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
            Sign in
          </div>
          <h2 className="font-display text-4xl leading-tight mb-10">
            Identify yourself.
          </h2>

          <form onSubmit={handleSubmit} className="space-y-7">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                value={formData.email}
                onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                className="w-full bg-transparent border-0 border-b border-border focus:border-accent text-foreground py-2 text-base font-mono tracking-wide outline-none transition-colors placeholder:text-muted-foreground/40"
                placeholder="e.g. s.tunley"
                required
              />
            </div>

            <div>
              <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData((prev) => ({ ...prev, password: e.target.value }))}
                  className="w-full bg-transparent border-0 border-b border-border focus:border-accent text-foreground py-2 pr-10 text-base font-mono tracking-wide outline-none transition-colors placeholder:text-muted-foreground/40"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-0 top-1/2 -translate-y-1/2 p-2 text-muted-foreground hover:text-accent transition-colors"
                  aria-label="Toggle password visibility"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {displayError && (
              <div className="flex items-start gap-3 border-l-2 border-destructive pl-3 py-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive mt-0.5">Err</span>
                <span className="text-sm text-foreground">{displayError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="group w-full flex items-center justify-between border border-foreground bg-transparent hover:bg-[hsla(33,95%,55%,0.18)] hover:border-[var(--phosphor)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)] disabled:opacity-50 disabled:cursor-not-allowed px-5 py-4 transition-all duration-200 mt-4"
            >
              <span className="font-mono text-xs uppercase tracking-[0.25em] font-medium">
                {isSubmitting ? "Authenticating" : "Authenticate"}
              </span>
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <span className="font-mono text-xs transition-transform group-hover:translate-x-1">
                  →
                </span>
              )}
            </button>
          </form>

          {appVersion && (
            <div className="mt-16 pt-4 border-t border-border flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Build
              </span>
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                v{appVersion}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
