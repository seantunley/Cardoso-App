import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// UI
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── ntopng / Network Settings Tab ────────────────────────────────────────
export default function NtopngTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["ntopng-settings"],
    queryFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load ntopng settings");
      return r.json();
    },
  });

  const [form, setForm] = useState({ ntopng_url: "", ntopng_user: "", ntopng_password: "" });
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (data) {
      setForm({
        ntopng_url: data.ntopng_url || "http://localhost:3000",
        ntopng_user: data.ntopng_user || "admin",
        // password is redacted server-side; keep blank so user can update it
        ntopng_password: "",
      });
      setDirty(false);
    }
  }, [data]);

  const handleChange = (field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    setDirty(true);
    setTestResult(null);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error("Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("ntopng settings saved");
      queryClient.invalidateQueries(["ntopng-settings"]);
      setDirty(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/hub/ntopng/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      const d = await r.json();
      setTestResult(d.ok ? { ok: true, msg: "Connected — " + (d.version || "ntopng responding") } : { ok: false, msg: d.error || "Connection failed" });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-base font-semibold mb-1">ntopng Connection</h3>
        <p className="text-sm text-muted-foreground mb-4">Configure the ntopng instance running on this Hub machine. Used by the Network Devices dashboard.</p>

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium">ntopng URL</Label>
            <Input
              className="mt-1"
              placeholder="http://localhost:3000"
              value={form.ntopng_url}
              onChange={e => handleChange("ntopng_url", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Username</Label>
            <Input
              className="mt-1"
              placeholder="admin"
              value={form.ntopng_user}
              onChange={e => handleChange("ntopng_user", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Password</Label>
            <Input
              className="mt-1"
              type="password"
              placeholder={data?.password_set ? "(password saved — leave blank to keep)" : "ntopng admin password"}
              value={form.ntopng_password}
              onChange={e => handleChange("ntopng_password", e.target.value)}
            />
          </div>
        </div>

        {testResult && (
          <p className={cn("text-sm mt-3", testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
            {testResult.ok ? "✓" : "✗"} {testResult.msg}
          </p>
        )}

        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="text-base font-semibold mb-1">Interface Naming Convention</h3>
        <p className="text-sm text-muted-foreground">
          Each site's nProbe instance must use <code className="text-xs bg-muted px-1 py-0.5 rounded">--interface-name nprobe-&lt;slug&gt;</code> where
          <code className="text-xs bg-muted px-1 py-0.5 rounded ml-1">&lt;slug&gt;</code> matches the site slug configured in <strong>HUB_SITES</strong>.
          For example: <code className="text-xs bg-muted px-1 py-0.5 rounded">nprobe-jhb</code>.
        </p>
      </div>
    </div>
  );
}
