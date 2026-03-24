import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UserPlus, Eye, EyeOff } from "lucide-react";

export default function CreateLocalUserModal({ open, onClose, onCreate, isCreating }) {
  const [formData, setFormData] = useState({
    full_name: "",
    email: "",
    role: "user",
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.password || formData.password.length < 8) return;
    await onCreate(formData);
    setFormData({ full_name: "", email: "", role: "user", password: "" });
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md bg-[var(--bg-secondary)] border-[var(--border-color)]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg">
              <UserPlus className="w-5 h-5 text-[var(--text-secondary)]" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold text-[var(--text-primary)]">
                Add User
              </DialogTitle>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Create a local account with a username and password
              </p>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">Full Name</Label>
            <Input
              type="text"
              value={formData.full_name}
              onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
              placeholder="Jane Smith"
              className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">Username</Label>
            <Input
              type="text"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="e.g. jsmith"
              required
              className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">Password</Label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Minimum 8 characters"
                required
                minLength={8}
                className="pr-10 bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
              />
              <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {formData.password.length > 0 && formData.password.length < 8 && (
              <p className="text-xs text-red-400">Password must be at least 8 characters</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-[var(--text-primary)]">Role</Label>
            <Select
              value={formData.role}
              onValueChange={(val) => setFormData({ ...formData, role: val })}
            >
              <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--bg-secondary)] border-[var(--border-color)]">
                <SelectItem value="user" className="text-[var(--text-primary)] focus:bg-[var(--bg-tertiary)] focus:text-[var(--text-primary)]">User</SelectItem>
                <SelectItem value="admin" className="text-[var(--text-primary)] focus:bg-[var(--bg-tertiary)] focus:text-[var(--text-primary)]">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-secondary)]">
              Admins have full access to all features and can manage users
            </p>
          </div>

          <DialogFooter className="pt-2">
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
              disabled={isCreating || !formData.email || !formData.password || formData.password.length < 8}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              {isCreating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create User
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
