import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Send, RefreshCw, Shield, Settings } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// sites = array of { site_id, site_name, site_slug } (from /api/hub/kpis)
export default function HubUserManager({ sites = [] }) {
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedSites, setSelectedSites] = useState(new Set());
  const [manageUser, setManageUser] = useState(null); // { id, email, allowed_sites }
  const [manageSiteIds, setManageSiteIds] = useState(new Set());
  const qc = useQueryClient();

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

  const saveAllowedSitesMutation = useMutation({
    mutationFn: async () => {
      const site_slugs = Array.from(manageSiteIds).map(id => {
        const s = sites.find(s2 => s2.site_id === id);
        return s ? s.site_slug : id;
      });
      const resp = await fetch(`/api/hub/users/${manageUser.id}/allowed-sites`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_slugs }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      return resp.json();
    },
    onSuccess: () => {
      toast.success(`Site access updated for ${manageUser.email}`);
      setManageUser(null);
      qc.invalidateQueries({ queryKey: ["hub-users"] });
    },
    onError: (err) => toast.error(err.message || "Failed to save"),
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

  const openManageDialog = (user) => {
    const allowed = user.allowed_sites || [];
    const allowedSlugSet = new Set(allowed.map(a => a.slug || a));
    const allowedIdSet = new Set(
      sites.filter(s => allowedSlugSet.has(s.site_slug)).map(s => s.site_id)
    );
    setManageUser(user);
    setManageSiteIds(allowedIdSet);
  };

  const toggleManageSite = (id) => setManageSiteIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

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
                    ? "bg-foreground text-background border-foreground ring-2 ring-[var(--phosphor)]/40"
                    : "border-border text-muted-foreground hover:border-[var(--phosphor)] hover:text-[var(--phosphor)]"
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
                <div className="flex flex-wrap gap-1 mt-1.5 items-center">
                  {u.sites && u.sites.length > 0 && u.sites.map(s => (
                    <span
                      key={s.slug}
                      title={`Pushed ${new Date(s.pushed_at).toLocaleDateString()}`}
                      className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.15em] px-1.5 py-0.5 bg-accent/10 text-accent border border-accent/30"
                      style={{ borderRadius: "2px" }}
                    >
                      {s.slug}
                    </span>
                  ))}
                  {u.allowed_sites && u.allowed_sites.length > 0 && (
                    <span className="text-[10px] text-emerald-400/70 ml-1">
                      ↔ {u.allowed_sites.length} allowed
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--phosphor)] flex-shrink-0"
                onClick={e => { e.stopPropagation(); openManageDialog(u); }}
                title="Manage site access"
              >
                <Settings className="h-3 w-3" />
              </Button>
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

      {/* Manage Site Access Dialog */}
      <Dialog open={!!manageUser} onOpenChange={open => { if (!open) setManageUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Site Access — {manageUser?.email}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[var(--text-secondary)] mb-3">
            Choose which sites <strong>{manageUser?.full_name || manageUser?.email}</strong> can see on the Hub.
            Leave all unchecked to give access to all sites.
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            {sites.map(s => (
              <button
                key={s.site_id}
                onClick={() => toggleManageSite(s.site_id)}
                className={cn(
                  "text-sm px-3 py-1.5 rounded-full border font-medium transition-all",
                  manageSiteIds.has(s.site_id)
                    ? "bg-foreground text-background border-foreground ring-2 ring-[var(--phosphor)]/40"
                    : "border-border text-muted-foreground hover:border-[var(--phosphor)] hover:text-[var(--phosphor)]"
                )}
              >
                {s.site_name || s.site_slug || s.site_id}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setManageUser(null)} className="gap-1.5">
              Cancel
            </Button>
            <Button
              onClick={() => saveAllowedSitesMutation.mutate()}
              disabled={saveAllowedSitesMutation.isPending}
              className="bg-foreground text-background hover:bg-[hsla(33,95%,55%,0.18)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)] gap-1.5"
            >
              {saveAllowedSitesMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
