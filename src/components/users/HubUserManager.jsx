import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Send, RefreshCw, Shield } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// sites = array of { site_id, site_name, site_slug } (from /api/hub/kpis)
export default function HubUserManager({ sites = [] }) {
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedSites, setSelectedSites] = useState(new Set());

  const { data: users = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["hub-users"],
    queryFn: () => fetch("/api/hub/users", { credentials: "include" }).then(r => r.json()),
  });

  const pushMutation = useMutation({
    mutationFn: async () => {
      const user_ids = Array.from(selectedUsers);
      const site_ids = selectedSites.size > 0 ? Array.from(selectedSites) : null;
      const resp = await fetch("/api/hub/push-users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids, site_ids }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      return resp.json();
    },
    onSuccess: (data) => {
      const ok = data.results.filter(r => r.ok);
      const failed = data.results.filter(r => !r.ok);
      if (ok.length) toast.success(`Pushed to: ${ok.map(r => r.site).join(", ")}`);
      failed.forEach(r => toast.error(`${r.site}: ${r.error}`));
      setSelectedUsers(new Set());
    },
    onError: (err) => toast.error(err.message || "Push failed"),
  });

  const toggleUser = (id) => setSelectedUsers(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleSite = (id) => setSelectedSites(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAllUsers = () => setSelectedUsers(
    selectedUsers.size === users.length ? new Set() : new Set(users.map(u => u.id))
  );

  const siteLabel = selectedSites.size > 0
    ? `${selectedSites.size} site${selectedSites.size === 1 ? "" : "s"}`
    : "all sites";
  const userLabel = selectedUsers.size > 0
    ? `${selectedUsers.size} user${selectedUsers.size === 1 ? "" : "s"}`
    : "selected users";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Push Users to Sites</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Select users and push their role, permissions, and status to site nodes.
          Passwords are never overwritten unless you've set a real password at the hub. Site badges show where each user has been pushed.
        </p>
      </div>

      {/* Site selector */}
      {sites.length > 0 && (
        <div>
          <p className="text-xs font-medium text-[var(--text-secondary)] mb-2 uppercase tracking-wide">
            Target sites <span className="normal-case font-normal">(leave all unselected = push to all)</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {sites.map(s => (
              <button
                key={s.site_id}
                onClick={() => toggleSite(s.site_id)}
                className={cn(
                  "text-sm px-3 py-1.5 rounded-full border font-medium transition-all",
                  selectedSites.has(s.site_id)
                    ? "bg-indigo-600 text-white border-indigo-600 ring-2 ring-indigo-400/50 shadow-md"
                    : "border-zinc-600 text-zinc-400 hover:border-indigo-500 hover:text-indigo-400"
                )}
              >
                {s.site_name || s.site_slug || s.site_id}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* User list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-[var(--text-secondary)] text-sm py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
        </div>
      ) : (
        <div className="border border-[var(--border-color)] rounded-xl overflow-hidden">
          {/* Select all row */}
          <div className="flex items-center gap-3 px-4 py-3 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)]">
            <Checkbox
              checked={users.length > 0 && selectedUsers.size === users.length}
              onCheckedChange={toggleAllUsers}
            />
            <span className="text-xs text-[var(--text-secondary)] flex-1">
              {selectedUsers.size > 0 ? `${selectedUsers.size} of ${users.length} selected` : `${users.length} user${users.length === 1 ? "" : "s"}`}
            </span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
            </Button>
          </div>

          {users.map((u, i) => (
            <div
              key={u.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors",
                i < users.length - 1 && "border-b border-[var(--border-color)]",
                selectedUsers.has(u.id) ? "bg-[var(--bg-tertiary)]" : "hover:bg-[var(--bg-secondary)]"
              )}
              onClick={() => toggleUser(u.id)}
            >
              <Checkbox
                checked={selectedUsers.has(u.id)}
                onCheckedChange={() => toggleUser(u.id)}
                onClick={e => e.stopPropagation()}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {u.full_name || u.email}
                  </span>
                  {u.role === "admin" && <Shield className="h-3 w-3 text-purple-400 flex-shrink-0" />}
                  {!u.is_active && (
                    <Badge variant="outline" className="text-xs border-red-700 text-red-400 py-0">Disabled</Badge>
                  )}
                </div>
                {u.full_name && (
                  <p className="text-xs text-[var(--text-secondary)] truncate">{u.email}</p>
                )}
                {u.sites && u.sites.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5" onClick={e => e.stopPropagation()}>
                    {u.sites.map(s => (
                      <span
                        key={s.slug}
                        title={`Pushed ${new Date(s.pushed_at).toLocaleDateString()}`}
                        className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800"
                      >
                        {s.slug}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs flex-shrink-0",
                  u.role === "admin"
                    ? "border-purple-700 text-purple-400"
                    : "border-[var(--border-color)] text-[var(--text-secondary)]"
                )}
              >
                {u.role}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* Push button */}
      <div className="flex justify-end">
        <Button
          onClick={() => pushMutation.mutate()}
          disabled={selectedUsers.size === 0 || pushMutation.isPending}
          className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90 gap-2"
        >
          {pushMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Push {userLabel} to {siteLabel}
        </Button>
      </div>
    </div>
  );
}
