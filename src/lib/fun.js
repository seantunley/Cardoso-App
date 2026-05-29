const CONFETTI_COLORS = ["#f59e0b", "#fbbf24", "#f8fafc", "#27272a"];

const CLEAN_IMPORT_MESSAGES = [
  "Clean landing",
  "Rows behaved",
  "Import tidy",
  "Data docked cleanly",
  "No drama, just rows",
];

const LEDGER_FORTUNES = [
  "No rows here. Suspiciously peaceful.",
  "Nothing to review. Enjoy this rare silence.",
  "The ledger is quiet. That still counts as progress.",
  "No entries found. The columns are taking five.",
  "Empty for now. Future rows have been notified.",
];

const COFFEE_MODE_EMPTY_LINES = [
  "No rows here. Coffee remains the active dataset.",
  "Nothing to review. Sip responsibly.",
  "Empty for now. The ledger is steeping.",
];

const OPERATOR_CODENAME_LEFT = [
  "Amber",
  "Quiet",
  "Copper",
  "Steady",
  "Phosphor",
  "Midnight",
  "Ledger",
  "Archive",
  "Signal",
  "Balance",
];

const OPERATOR_CODENAME_RIGHT = [
  "Index",
  "Beacon",
  "Column",
  "Relay",
  "Receipt",
  "Cipher",
  "Close",
  "Ledger",
  "Marker",
  "Tally",
];

function dailySeed(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function getSafeLocalStorage() {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

export function cleanImportMessage(fallback = "Import complete") {
  const index = Math.floor(Date.now() / 60000) % CLEAN_IMPORT_MESSAGES.length;
  return CLEAN_IMPORT_MESSAGES[index] || fallback;
}

export function recordCleanSyncStreak() {
  const storage = getSafeLocalStorage();
  if (!storage) return 0;

  const key = "cardoso-clean-sync-streak";
  try {
    const next = Number(storage.getItem(key) || "0") + 1;
    storage.setItem(key, String(next));
    return next;
  } catch {
    return 0;
  }
}

/** @param {{ imported?: number, target?: string | number | null }} [opts] */
export function cleanImportToastMessage({ imported = 0, target } = {}) {
  const streak = recordCleanSyncStreak();
  if (streak > 0 && streak % 3 === 0) {
    return `${streak} clean syncs in a row. The ledger approves.`;
  }

  const suffix = target ? `${target} - ${imported} records` : `${imported} records imported.`;
  return `${cleanImportMessage()} - ${suffix}`;
}

export function resetCleanSyncStreak() {
  const storage = getSafeLocalStorage();
  if (!storage) return;

  try {
    storage.removeItem("cardoso-clean-sync-streak");
  } catch {
    // Storage may be blocked in restricted contexts; sync error handling must continue.
  }
}

export function getLedgerFortune(date = new Date()) {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("cardoso-coffee-mode")) {
    return COFFEE_MODE_EMPTY_LINES[date.getSeconds() % COFFEE_MODE_EMPTY_LINES.length];
  }

  const seed = dailySeed(date);
  return LEDGER_FORTUNES[seed % LEDGER_FORTUNES.length];
}

export function getDailyOperatorCodename(date = new Date()) {
  const seed = dailySeed(date);
  const left = OPERATOR_CODENAME_LEFT[seed % OPERATOR_CODENAME_LEFT.length];
  const right = OPERATOR_CODENAME_RIGHT[Math.floor(seed / 3) % OPERATOR_CODENAME_RIGHT.length];
  return `${left} ${right}`;
}

export function getJohannesburgGreeting(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    hour12: false,
  }).format(date)) % 24;

  if (hour < 5) return "Night shift. Keep the books quiet.";
  if (hour < 12) return "Morning. Let's keep the books tidy.";
  if (hour < 17) return "Afternoon. Small checks, clean closes.";
  if (hour < 21) return "Evening close. Check variance, then go home proud.";
  return "Late ledger hours. Steady hands.";
}

export function getVariancePersonality(variance) {
  const amount = Math.abs(Number(variance) || 0);
  if (amount > 0 && amount < 1) return `R${amount.toFixed(2)} variance - technically annoying`;
  return null;
}

export function getReportSignature(date = new Date()) {
  return `Generated cleanly by Cardoso Ledger - Johannesburg time ${new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

export function activateCoffeeMode(duration = 15_000) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.classList.add("cardoso-coffee-mode");
  window.dispatchEvent(new CustomEvent("cardoso-fun-mode", { detail: { mode: "coffee" } }));
  window.setTimeout(() => {
    document.documentElement.classList.remove("cardoso-coffee-mode");
    window.dispatchEvent(new CustomEvent("cardoso-fun-mode", { detail: { mode: null } }));
  }, duration);
}

export function launchLedgerConfetti({ duration = 900, particleCount = 3 } = {}) {
  import("canvas-confetti")
    .then(({ default: confetti }) => {
      const end = Date.now() + duration;

      function frame() {
        confetti({
          particleCount,
          angle: 60,
          spread: 55,
          origin: { x: 0 },
          colors: CONFETTI_COLORS,
          scalar: 0.8,
        });
        confetti({
          particleCount,
          angle: 120,
          spread: 55,
          origin: { x: 1 },
          colors: CONFETTI_COLORS,
          scalar: 0.8,
        });

        if (Date.now() < end) window.requestAnimationFrame(frame);
      }

      frame();
    })
    .catch(() => {});
}

export function pulseSecretGlow(duration = 30_000) {
  document.documentElement.classList.add("cardoso-secret-glow");
  window.setTimeout(() => {
    document.documentElement.classList.remove("cardoso-secret-glow");
  }, duration);
}
