import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, KeyRound, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

export default function ForcePasswordChangeModal({ open, onComplete }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const valid = password.length >= 6 && password === confirm;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    setLoading(true);
    try {
      const resp = await fetch("/api/auth/set-initial-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed");
      if (data.hub_redirect) {
        window.location.href = data.hub_redirect;
        return;
      }
      toast.success("Password set — welcome!");
      onComplete(data.user);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="bg-accent/10 p-2" style={{ borderRadius: "12px" }}>
              <KeyRound className="h-5 w-5 text-accent" />
            </div>
            <DialogTitle className="text-lg">Set your password</DialogTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Your account was created with a temporary password. Please set a new one before continuing.
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label>New password</Label>
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoFocus
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShow(v => !v)}
                tabIndex={-1}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Confirm password</Label>
            <Input
              type={show ? "text" : "password"}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat new password"
            />
            {confirm && password !== confirm && (
              <p className="text-xs text-red-400">Passwords don't match</p>
            )}
          </div>

          <Button type="submit" className="w-full gap-2" disabled={!valid || loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Set password & continue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
