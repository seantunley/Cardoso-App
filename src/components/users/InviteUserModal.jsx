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
import { Loader2, UserPlus } from "lucide-react";

export default function InviteUserModal({ open, onClose, onInvite, isInviting }) {
  const [formData, setFormData] = useState({
    email: "",
    role: "user",
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    await onInvite(formData.email, formData.role);
    setFormData({ email: "", role: "user" });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-100 rounded-lg">
              <UserPlus className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold">
                Invite User
              </DialogTitle>
              <p className="text-sm text-slate-500 mt-0.5">
                Send an invitation to a new user
              </p>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-slate-700">Email Address</Label>
            <Input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="user@example.com"
              required
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-slate-700">Role</Label>
            <Select
              value={formData.role}
              onValueChange={(val) => setFormData({ ...formData, role: val })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">
              Admins have full access to all features and can manage users
            </p>
          </div>

          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isInviting} className="bg-slate-900 hover:bg-slate-800">
              {isInviting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Send Invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}