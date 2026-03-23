import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, KeyRound } from "lucide-react";

export default function ChangePasswordModal({
  user,
  open,
  onClose,
  onSave,
  isSaving,
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirmPassword("");
      setError("");
    }
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!password || password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    await onSave(user.id, password);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md bg-[var(--bg-secondary)] border-[var(--border-color)]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg">
              <KeyRound className="w-5 h-5 text-[var(--text-secondary)]" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold text-[var(--text-primary)]">
                Change Password
              </DialogTitle>
              {user && (
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                  {user.full_name || user.email}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">
              New Password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 6 characters"
              className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
              required
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">
              Confirm Password
            </Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
              required
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Update Password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}