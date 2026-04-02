// src/pages/Login.jsx

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Lock, User, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CardosoBriefcase = ({ size = 48 }) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
    <rect width="32" height="32" rx="8" fill="#1e293b"/>
    <rect x="4" y="13" width="24" height="15" rx="3" fill="url(#lg1)"/>
    <rect x="4" y="19" width="24" height="2" fill="#1d4ed8"/>
    <rect x="13" y="17" width="6" height="6" rx="1.5" fill="#bfdbfe"/>
    <path d="M11 13v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" fill="none"/>
    <defs>
      <linearGradient id="lg1" x1="4" y1="13" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop stopColor="#3b82f6"/>
        <stop offset="1" stopColor="#6366f1"/>
      </linearGradient>
    </defs>
  </svg>
);

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoadingAuth, authError } = useAuth();

  const [formData, setFormData] = useState({ email: "", password: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

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
      setLocalError("Please enter your username and password.");
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: "radial-gradient(ellipse at 60% 0%, #1e3a5f 0%, #0f172a 60%)" }}>
        <div className="flex items-center gap-3 text-slate-300">
          <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
          <span className="text-sm">Checking session…</span>
        </div>
      </div>
    );
  }

  const displayError = localError || authError?.message;

  return (
    <div
      className="min-h-screen flex"
      style={{ background: "radial-gradient(ellipse at 65% 0%, #1e3a5f 0%, #0f172a 55%)" }}
    >
      {/* ── Left panel (hidden on mobile) ── */}
      <div className="hidden lg:flex lg:flex-1 flex-col justify-between p-12 relative overflow-hidden">
        {/* Decorative glow blobs */}
        <div
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "radial-gradient(circle at 30% 50%, rgba(99,102,241,0.15) 0%, transparent 65%), radial-gradient(circle at 80% 80%, rgba(59,130,246,0.1) 0%, transparent 55%)",
          }}
        />
        {/* Brand */}
        <div className="flex items-center gap-3 relative z-10">
          <CardosoBriefcase size={36} />
          <span className="text-lg font-bold text-white tracking-tight">Cardoso Cigarettes</span>
        </div>
        {/* Hero copy */}
        <div className="relative z-10 max-w-sm">
          <h2 className="text-3xl font-bold text-white leading-snug mb-3">
            Your business,<br />under control.
          </h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            Manage customers, track balances, monitor inventory, and keep your team aligned — all in one place.
          </p>
          {/* Decorative stat pills */}
          <div className="mt-8 flex flex-wrap gap-3">
            {[
              { label: "Customer Records", color: "rgba(59,130,246,0.2)", border: "rgba(59,130,246,0.4)", text: "#93c5fd" },
              { label: "Auto-Flagging", color: "rgba(16,185,129,0.2)", border: "rgba(16,185,129,0.4)", text: "#6ee7b7" },
              { label: "Hub Dashboard", color: "rgba(99,102,241,0.2)", border: "rgba(99,102,241,0.4)", text: "#c7d2fe" },
            ].map(p => (
              <span
                key={p.label}
                className="text-xs font-medium px-3 py-1.5 rounded-full"
                style={{ background: p.color, border: `1px solid ${p.border}`, color: p.text }}
              >
                {p.label}
              </span>
            ))}
          </div>
        </div>
        {/* Footer */}
        <p className="text-xs text-slate-600 relative z-10">© 2026 Cardoso Cigarettes. All rights reserved.</p>
      </div>

      {/* ── Right panel (login form) ── */}
      <div className="w-full lg:w-[420px] flex flex-col items-center justify-center p-8 lg:p-12">
        {/* Mobile brand header */}
        <div className="lg:hidden flex flex-col items-center mb-8 gap-2">
          <CardosoBriefcase size={44} />
          <h1 className="text-xl font-bold text-white tracking-tight">Cardoso Cigarettes</h1>
          <p className="text-sm text-slate-400">Customer Manager</p>
        </div>

        {/* Card */}
        <div
          className="w-full rounded-2xl p-8"
          style={{
            background: "rgba(15,23,42,0.85)",
            border: "1px solid rgba(99,102,241,0.2)",
            boxShadow: "0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03)",
            backdropFilter: "blur(12px)",
          }}
        >
          {/* Desktop brand inside card */}
          <div className="hidden lg:flex items-center gap-2.5 mb-7">
            <CardosoBriefcase size={28} />
            <div>
              <div className="text-sm font-semibold text-white leading-tight">Cardoso Cigarettes</div>
              <div className="text-[11px] text-slate-500">Customer Manager</div>
            </div>
          </div>

          <h2 className="text-xl font-bold text-white mb-1">Welcome back</h2>
          <p className="text-sm text-slate-400 mb-6">Sign in to your account to continue</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-300">Username</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  type="text"
                  autoComplete="username"
                  value={formData.email}
                  onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder="Enter your username"
                  className="pl-10 text-sm"
                  style={{
                    background: "rgba(30,41,59,0.8)",
                    border: "1px solid rgba(99,102,241,0.25)",
                    color: "#f1f5f9",
                  }}
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-300">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Enter your password"
                  className="pl-10 pr-10 text-sm"
                  style={{
                    background: "rgba(30,41,59,0.8)",
                    border: "1px solid rgba(99,102,241,0.25)",
                    color: "#f1f5f9",
                  }}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  aria-label="Toggle password visibility"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Error */}
            {displayError && (
              <div
                className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm text-red-300"
                style={{ background: "rgba(153,27,27,0.2)", border: "1px solid rgba(239,68,68,0.3)" }}
              >
                <span className="mt-0.5 shrink-0">⚠</span>
                <span>{displayError}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition-all duration-200 mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                background: isSubmitting
                  ? "rgba(99,102,241,0.6)"
                  : "linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)",
                boxShadow: isSubmitting ? "none" : "0 4px 20px rgba(79,70,229,0.4)",
              }}
            >
              {isSubmitting
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</>
                : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-xs text-slate-600 text-center lg:hidden">© 2026 Cardoso Cigarettes</p>
      </div>
    </div>
  );
}
