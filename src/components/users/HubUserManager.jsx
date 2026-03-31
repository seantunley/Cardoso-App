import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Users, Send, RefreshCw, Shield, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function HubUserManager({ sites = [] }) {
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedSites, setSelectedSites] = useState(new Set());
  const [expanded, setExpanded] = useState(false);

  const { data: users = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["hub-users"],
    queryFn: () => fetch("/api/hub/users", { credentials: "include" }).then(r => r.json()),
    enabled: expanded,
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

  const siteCount = selectedSites.size > 0 ? `${selectedSites.size} site${selectedSites.size === 1 ? "" : "s"}` : "all sites";
  const userLabel = selectedUsers.size > 0 ? `${selectedUsers.size} user${selectedUsers.size === 1 ? "" : "s"}` : "selected users";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Centralised User Management</span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-border px-5 pb-5 pt-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Select users and push their role, permissions, and status to sites. Passwords are never overwritten — new users must set their password locally after being pushed.
          </p>

          {sites.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Target sites (leave all unselected = push to all):</p>
              <div className="flex flex-wrap gap-2">
                {sites.map(s => (
                  <button
                    key={s.site_id}
                    onClick={() => toggleSite(s.site_id)}
                    className={cn(
                      "text-xs px-3 py-1 rounded-full border transition-colors",
                      selectedSites.has(s.site_id)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    )}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2 bg-muted/20 border-b border-border">
                <Checkbox
                  checked={users.length > 0 && selectedUsers.size === users.length}
                  onCheckedChange={toggleAllUsers}
                />
                <span className="text-xs text-muted-foreground flex-1">
                  {selectedUsers.size > 0 ? `${selectedUsers.size} of ${users.length} selected` : `${users.length} users`}
                </span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
                </Button>
              </div>
              {users.map((u, i) => (
                <div
                  key={u.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors",
                    i < users.length - 1 && "border-b border-border",
                    selectedUsers.has(u.id) ? "bg-primary/10" : "hover:bg-muted/30"
                  )}
                  onClick={() => toggleUser(u.id)}
                >
                  <Checkbox checked={selectedUsers.has(u.id)} onCheckedChange={() => toggleUser(u.id)} onClick={e => e.stopPropagation()} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground truncate">{u.full_name || u.email}</span>
                      {u.role === "admin" && <Shield className="h-3 w-3 text-purple-400 flex-shrink-0" />}
                      {!u.is_active && <Badge variant="outline" className="text-xs border-red-700 text-red-400 py-0">Disabled</Badge>}
                    </div>
                    {u.full_name && <p className="text-xs text-muted-foreground truncate">{u.email}</p>}
                  </div>
                  <Badge variant="outline" className={cn("text-xs flex-shrink-0", u.role === "admin" ? "border-purple-700 text-purple-400" : "border-border text-muted-foreground")}>
                    {u.role}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={() => pushMutation.mutate()}
              disabled={selectedUsers.size === 0 || pushMutation.isPending}
              size="sm"
              className="gap-2"
            >
              {pushMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Push {userLabel} to {siteCount}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
