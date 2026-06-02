// Operations page — admin-only home for "what's the system doing?" views.
// Folds together what used to live as scattered Settings tabs (System Log,
// Updates) and the standalone hub-mode Hub Sync Log page, plus a brand-new
// Job Runs panel powered by the job_runs table (PR #178).
//
// Read-only by intent. The original 30/60/90 plan called for "run now /
// retry / pause" buttons but the agreed-on MVP shape is glance-and-see.
// Action buttons can land in follow-up PRs once we know which ones the
// operator actually reaches for.
//
// IA decision: Audit Log stays in Settings — it's a security/who-did-what
// artefact, not a background-work view. The other "logs" all answer
// "what happened in the background?" and belong together here.

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { useHubMode } from "@/lib/useAppInfo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, AlertTriangle, Download, RefreshCw, Shield, ScanLine, Calendar } from "lucide-react";
import { toast } from "sonner";

import JobRunsPanel from "@/components/operations/JobRunsPanel";
import SchedulePanel from "@/components/operations/SchedulePanel";
import SystemLogPanel from "@/components/operations/SystemLogPanel";
import UpdatesPanel from "@/components/operations/UpdatesPanel";
import SecuritySignalsPanel from "@/components/operations/SecuritySignalsPanel";
import OcrPanel from "@/components/operations/OcrPanel";
import HubSyncLog from "@/pages/HubSyncLog";
import SageHealthPanel from "@/components/health/SageHealthPanel";

export default function Operations() {
  const { user } = useAuth();
  const hubMode = useHubMode();
  const [activeTab, setActiveTab] = useState("jobs");
  const [detectiveMode, setDetectiveMode] = useState(false);
  const [traceMode, setTraceMode] = useState(false);

  // Surface background job failures as a badge on the Job Runs tab so the
  // operator doesn't have to open the tab to discover something broke.
  const jobsBadgeQuery = useQuery({
    queryKey: ["ops-jobs-badge"],
    queryFn: () => fetch("/api/system/jobs", { credentials: "include" }).then((r) => (r.ok ? r.json() : { jobs: [] })),
    staleTime: 60_000,
    refetchInterval: 60_000,
    enabled: !!user,
  });
  const jobFailures = (jobsBadgeQuery.data?.jobs || []).reduce((s, j) => s + (j.failures_in_window || 0), 0);

  useEffect(() => {
    let logsIndex = 0;
    let traceIndex = 0;
    const logsSequence = ["KeyL", "KeyO", "KeyG", "KeyS"];
    const traceSequence = ["KeyT", "KeyR", "KeyA", "KeyC", "KeyE"];

    const handleKeyDown = (event) => {
      // Bail out when the user is typing into a form control. This
      // handler is global (window.addEventListener), so without this
      // check, typing "LOGS" or "TRACE" into the OCR / system-log
      // filter inputs (or any other input/textarea/select on the
      // Operations page) would silently switch tabs and fire a toast
      // mid-typing — confusing user-visible disruption during normal
      // input.
      const target = event.target;
      const isEditable =
        target?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ||
        target?.isContentEditable;
      if (isEditable) return;

      logsIndex = event.code === logsSequence[logsIndex]
        ? logsIndex + 1
        : event.code === logsSequence[0]
          ? 1
          : 0;
      traceIndex = event.code === traceSequence[traceIndex]
        ? traceIndex + 1
        : event.code === traceSequence[0]
          ? 1
          : 0;

      if (logsIndex === logsSequence.length) {
        logsIndex = 0;
        setActiveTab("system-log");
        setDetectiveMode(true);
        toast("Detective mode enabled");
        window.setTimeout(() => setDetectiveMode(false), 5000);
      }

      if (traceIndex === traceSequence.length) {
        traceIndex = 0;
        setActiveTab("system-log");
        setTraceMode(true);
        toast("Trace mode armed");
        window.setTimeout(() => setTraceMode(false), 7000);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Defence in depth — the route is gated by ProtectedRoute already, but
  // belt-and-suspenders so a non-admin browsing here directly gets a clear
  // message, not a cluttered page they can't read.
  const isAdmin = user?.role === "admin";
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-8 py-16 text-center">
          <h1 className="font-display text-3xl text-foreground mb-3">Operations</h1>
          <p className="text-sm text-muted-foreground">
            This page is admin-only — it surfaces background job runs, system errors, and update status.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="px-6 py-5 space-y-8">
        <div className="border-b border-border pb-5">

          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            What the system is <em className="text-phosphor">doing</em>.
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
            Background jobs{!hubMode && " · OCR worker"} · System errors · Deploy history{hubMode && " · Hub sync"}
          </p>
        </div>

        {/* Site-mode Sage health at a glance — same panel as the Reporting
            dashboard. Hidden on the hub, whose sync sources differ. */}
        {!hubMode && <SageHealthPanel />}

        {detectiveMode && (
          <div className="border border-accent/50 bg-accent/10 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            Detective mode enabled · System Log highlighted
          </div>
        )}
        {traceMode && (
          <div className="border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300">
            Trace mode armed · Following the clues
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-muted/40">
            <TabsTrigger value="jobs" className="data-[state=active]:bg-background">
              <Activity className="w-3.5 h-3.5 mr-1.5" /> Job Runs
              {jobFailures > 0 && (
                <span
                  className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
                  title={`${jobFailures} job failure(s) in the last 24h`}
                >
                  {jobFailures}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="schedule" className="data-[state=active]:bg-background">
              <Calendar className="w-3.5 h-3.5 mr-1.5" /> Schedule
            </TabsTrigger>
            {/* OCR pipeline runs on sites only — the Hub aggregates
                from sites' /api/reporting/* and never executes its own
                OCR worker. Hide the tab + panel so a hub-mode operator
                doesn't get an empty/confusing view. */}
            {!hubMode && (
              <TabsTrigger value="ocr" className="data-[state=active]:bg-background">
                <ScanLine className="w-3.5 h-3.5 mr-1.5" /> OCR
              </TabsTrigger>
            )}
            <TabsTrigger value="system-log" className="data-[state=active]:bg-background">
              <AlertTriangle className="w-3.5 h-3.5 mr-1.5" /> System Log
            </TabsTrigger>
            <TabsTrigger value="security" className="data-[state=active]:bg-background">
              <Shield className="w-3.5 h-3.5 mr-1.5" /> Security
            </TabsTrigger>
            <TabsTrigger value="updates" className="data-[state=active]:bg-background">
              <Download className="w-3.5 h-3.5 mr-1.5" /> Updates
            </TabsTrigger>
            {hubMode && (
              <TabsTrigger value="hub-sync" className="data-[state=active]:bg-background">
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Hub Sync Log
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="jobs" className="mt-0">
            <JobRunsPanel />
          </TabsContent>
          <TabsContent value="schedule" className="mt-0">
            <SchedulePanel />
          </TabsContent>
          {!hubMode && (
            <TabsContent value="ocr" className="mt-0">
              <OcrPanel />
            </TabsContent>
          )}
          <TabsContent
            value="system-log"
            className={`mt-0 ${
              detectiveMode || traceMode
                ? "ring-1 ring-accent/70 shadow-[0_0_24px_hsla(33,95%,55%,0.18)]"
                : ""
            }`}
          >
            <SystemLogPanel />
          </TabsContent>
          <TabsContent value="security" className="mt-0">
            <SecuritySignalsPanel />
          </TabsContent>
          <TabsContent value="updates" className="mt-0">
            <UpdatesPanel />
          </TabsContent>
          {hubMode && (
            <TabsContent value="hub-sync" className="mt-0">
              {/* HubSyncLog is the existing standalone page component.
                  It renders its own page chrome so it nests cleanly here
                  as a tab — no changes needed. */}
              <HubSyncLog />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
