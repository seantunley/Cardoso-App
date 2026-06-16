// src/pages/Login.jsx

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { reportClientError } from "@/lib/clientLog";
import { getDailyOperatorCodename, getJohannesburgGreeting } from "@/lib/fun";
import PhosphorTraces from "@/components/login/PhosphorTraces";

const DAILY_LOGIN_QUOTES = [
  "Tiny checks now save heroic fixes later.",
  "Reconcile first. Panic never.",
  "Clean data has a very particular kind of swagger.",
  "Today's best report starts with yesterday's tidy rows.",
  "If the numbers agree, let the coffee take the credit.",
  "A calm ledger is a beautiful thing.",
  "Measure twice, sync once.",
  "The quietest systems usually did their homework.",
  "Good records make future-you suspiciously grateful.",
  "Every tidy row is a tiny act of optimism.",
  "A weird variance is just a clue wearing a hat.",
  "Trust the audit trail. It remembers things.",
  "One clean import can improve the whole afternoon.",
  "Logs are breadcrumbs for tomorrow's detective work.",
  "The best dashboards tell the truth politely.",
  "A settled account sleeps well.",
  "Small fixes compound like interest.",
  "When in doubt, follow the invoice number.",
  "Precision is just kindness with columns.",
  "A good backup is boring. Boring is excellent.",
  "The spreadsheet blinked first.",
  "Keep the books neat and the surprises small.",
  "Consistency is the secret sauce nobody screenshots.",
  "No drama, just data.",
  "The day improves when totals agree.",
  "A clean reconciliation is its own little celebration.",
  "Slow is smooth. Smooth is posted.",
  "A careful operator beats a clever shortcut.",
  "The database appreciates your attention.",
  "Today's mission: make tomorrow easier.",
  "Somewhere, a future report is thanking you.",
];

const FRIDAY_LOGIN_QUOTES = [
  "Friday totals should leave quietly and on time.",
  "If the books balance today, Monday gets a softer landing.",
  "The ledger is dressed casual. Still precise.",
  "A clean Friday close is basically office poetry.",
];

const MONDAY_LOGIN_QUOTES = [
  "Start gentle. Then reconcile.",
  "Monday likes a small win before the big one.",
  "Fresh week, clean rows, steady hands.",
];

const USERNAME_EXAMPLES = [
  "j.doe",
  "m.mouse",
  "b.balance",
  "p.ledger",
  "c.audit",
  "t.totals",
  "s.sync",
  "r.receipt",
  "v.variance",
  "a.account",
  "d.debit",
  "c.credit",
  "q.queue",
  "n.numbers",
];

function getDailyLoginQuote(date = new Date()) {
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  if (date.getDay() === 5) return FRIDAY_LOGIN_QUOTES[seed % FRIDAY_LOGIN_QUOTES.length];
  if (date.getDay() === 1) return MONDAY_LOGIN_QUOTES[seed % MONDAY_LOGIN_QUOTES.length];
  return DAILY_LOGIN_QUOTES[seed % DAILY_LOGIN_QUOTES.length];
}

function getRandomUsernameExample() {
  return USERNAME_EXAMPLES[Math.floor(Math.random() * USERNAME_EXAMPLES.length)];
}

function formatJohannesburgDateTime(date) {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function LedgerSparkline() {
  return (
    <svg viewBox="0 0 120 34" className="mt-4 h-8 w-full max-w-[220px]" aria-hidden="true">
      <path
        d="M2 26 L18 24 L31 18 L44 20 L58 11 L72 14 L86 7 L102 10 L118 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ledger-sparkline-path text-accent"
      />
      <path d="M2 30 H118" fill="none" stroke="currentColor" strokeWidth="1" className="text-border" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoadingAuth, authError } = useAuth();

  const [formData, setFormData] = useState({ email: "", password: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [clockNow, setClockNow] = useState(() => new Date());
  const [footerClicks, setFooterClicks] = useState(0);
  const [nightShiftMode, setNightShiftMode] = useState(false);
  const [usernameExample] = useState(() => getRandomUsernameExample());

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

  useEffect(() => {
    const tick = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

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
  const quoteOfTheDay = getDailyLoginQuote();
  const quoteText = nightShiftMode
    ? "Night shift mode enabled. The ledger likes a quiet room."
    : quoteOfTheDay;
  const johannesburgDateTime = formatJohannesburgDateTime(clockNow);
  const johannesburgGreeting = getJohannesburgGreeting(clockNow);
  const operatorCodename = getDailyOperatorCodename(clockNow);

  const handleLocationClick = () => {
    setFooterClicks((count) => {
      const next = count + 1;
      if (next >= 5) {
        setNightShiftMode(true);
        window.setTimeout(() => {
          setNightShiftMode(false);
          setFooterClicks(0);
        }, 7000);
        return 0;
      }
      return next;
    });
  };

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
        {/* Live phosphor telemetry — drifting glowing traces (pure decoration;
            static under prefers-reduced-motion, paused when the tab is hidden) */}
        {/* Full-height ambient layer. The quote card and footer sit IN FRONT
            of it on their own solid blurred backdrops (z-10 + bg-card/85),
            so the visualisation can live at the bottom without swallowing
            the content. */}
        <PhosphorTraces />
        {/* Soft dot matrix — replaces the old square hairline grid */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.06]"
          style={{
            backgroundImage: "radial-gradient(hsl(var(--foreground)) 1px, transparent 1.5px)",
            backgroundSize: "26px 26px",
          }}
        />

        {/* Top mark */}
        <div className="relative z-10 flex items-center">
          <img
            src="/cardoso-logo-orange.png"
            alt="Cardoso Depots"
            className="h-28 w-auto"
            style={{ filter: "drop-shadow(0 0 28px hsla(33,95%,55%,0.4))" }}
          />
        </div>

        {/* Hero quote */}
        <div className="relative z-10 max-w-xl">

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
        <div className="relative z-10 space-y-8">
          <div className="max-w-md rounded-2xl border border-white/10 bg-card/55 backdrop-blur-2xl p-5" style={{ boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.08)" }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-accent mb-3">
              Quote of the day
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              "{quoteText}"
            </p>
            <LedgerSparkline />
          </div>
          <div className="flex items-end justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <span>© 2026 Cardoso Cigarettes</span>
            <span className="flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={handleLocationClick}
                className="border-0 bg-transparent p-0 font-mono uppercase tracking-[0.25em] text-inherit transition-colors hover:text-accent"
                title="Johannesburg office time"
              >
                Johannesburg / ZA
              </button>
              <span className="flex items-center gap-2 text-accent tabular-nums">
                <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                {johannesburgDateTime}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Right: the terminal ── */}
      <div className="flex-1 lg:flex-none lg:w-[480px] flex flex-col justify-center px-6 py-16 lg:px-16 relative">
        {/* Mobile mark */}
        <div className="lg:hidden mb-12 flex items-center">
          <img
            src="/cardoso-logo-orange.png"
            alt="Cardoso Depots"
            className="h-16 w-auto"
          />
        </div>

        <div
          className="max-w-sm w-full rounded-3xl border border-white/10 bg-card/50 backdrop-blur-2xl p-8 lg:p-9"
          style={{ boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.10), 0 0 60px hsla(33,95%,55%,0.10), 0 24px 50px -12px rgba(0,0,0,0.5)" }}
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
            Sign in
          </div>
          <div className="mb-5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            Operator codename: {operatorCodename}
          </div>
          <h2 className="font-display text-4xl leading-tight mb-10">
            Identify yourself.
          </h2>

          <div className="lg:hidden mb-8 rounded-2xl border border-white/10 bg-card/45 backdrop-blur-2xl p-5" style={{ boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.08)" }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-accent mb-2">
              Quote of the day
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              "{quoteText}"
            </p>
            <LedgerSparkline />
          </div>

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
                className="w-full rounded-2xl border border-border bg-background/60 focus:border-accent focus:ring-2 focus:ring-accent/25 text-foreground px-4 py-3 text-base font-mono tracking-wide outline-none transition-all placeholder:text-muted-subtle"
                placeholder={`e.g. ${usernameExample}`}
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
                  className="w-full rounded-2xl border border-border bg-background/60 focus:border-accent focus:ring-2 focus:ring-accent/25 text-foreground px-4 py-3 pr-12 text-base font-mono tracking-wide outline-none transition-all placeholder:text-muted-subtle"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors"
                  aria-label="Toggle password visibility"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {displayError && (
              <div className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive mt-0.5">Err</span>
                <span className="text-sm text-foreground">{displayError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="group w-full flex items-center justify-between rounded-full border border-accent/60 bg-accent/10 hover:bg-[hsla(33,95%,55%,0.22)] hover:border-[var(--phosphor)] hover:shadow-[0_0_18px_hsla(33,95%,55%,0.4)] disabled:opacity-50 disabled:cursor-not-allowed px-7 py-4 transition-all duration-200 mt-4"
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
              <span
                className="font-mono text-[10px] text-muted-foreground tabular-nums"
                title="Shipped with care. Probably coffee."
              >
                v{appVersion}
              </span>
            </div>
          )}
          <div className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {johannesburgGreeting}
          </div>
        </div>
      </div>
    </div>
  );
}
