import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiSend } from "./utils";

export default function NewWorklistDialog({ open, onClose, users, onCreated }) {
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => apiSend("/api/collections/worklists", "POST", {
      name, owner_user_id: ownerId ? Number(ownerId) : null, description: description || null,
    }),
    onSuccess: (data) => {
      toast({ title: "Worklist created" });
      onCreated?.(data.worklist);
      setName(""); setOwnerId(""); setDescription("");
      onClose();
    },
    onError: (e) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worklist</DialogTitle>
          <DialogDescription>Name a worklist and (optionally) assign it to a rep.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mark — JHB Hold accounts" autoFocus title="Display name for the worklist (collection_worklists.name). Shown in the sidebar and on assignment audit entries." />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Owner</label>
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              title="User who owns this worklist (collection_worklists.owner_user_id). Owners and admins can assign or remove customers."
              className="w-full h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground cursor-help"
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name || u.email} ({u.email})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} title="Free-text description stored on collection_worklists.description. Not customer-facing." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} title="Insert a new collection_worklists row. The selected owner becomes the default editor; the action is logged to audit_log.">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
