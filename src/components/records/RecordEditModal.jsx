import { useState, useEffect } from "react";
import { Zap, Flag } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";  // NEW: Import DialogDescription
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { cn } from "@/lib/utils";

const flagColors = {
  none: "bg-slate-700 text-slate-300 border-slate-600",
  red: "bg-red-900/60 text-red-300 border-red-700",
  green: "bg-green-900/60 text-green-300 border-green-700",
  orange: "bg-orange-900/60 text-orange-300 border-orange-700",
};
const flagDot = { none: "bg-slate-400", red: "bg-red-500", green: "bg-green-500", orange: "bg-orange-500" };

export default function RecordEditModal({ open, onClose, record, onSave }) {
  const [formData, setFormData] = useState({});
  useEffect(() => {
    if (record) {
      // Parse local_fields JSON so dynamic custom field values are accessible by key
      let parsedLocalFields = {};
      try {
        parsedLocalFields = typeof record.local_fields === "string"
          ? JSON.parse(record.local_fields || "{}")
          : record.local_fields || {};
      } catch {}

      setFormData({
        customer_name: record.customer_name || "",
        ...parsedLocalFields,
      });
    }
  }, [record]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Enter') handleSave(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, handleSave]);

  const handleSave = () => {
    // Separate built-in fields from dynamic custom fields (those not in datarecord columns)
    const builtInKeys = new Set([
      "customer_name", "customer_number", "age_analysis", "note",
      ]);

    const builtInChanges = {};
    const dynamicChanges = {};

    for (const [key, value] of Object.entries(formData)) {
      if (builtInKeys.has(key)) {
        builtInChanges[key] = value;
      } else {
        dynamicChanges[key] = value;
      }
    }

    // Merge dynamic changes into existing local_fields
    let existingLocalFields = {};
    try {
      existingLocalFields = typeof record.local_fields === "string"
        ? JSON.parse(record.local_fields || "{}")
        : record.local_fields || {};
    } catch {}

    const updatedLocalFields = { ...existingLocalFields, ...dynamicChanges };

    onSave({
      ...record,
      ...builtInChanges,
      local_fields: JSON.stringify(updatedLocalFields),
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle>Edit Record</DialogTitle>
          <DialogDescription>Modify the customer name and custom fields below.</DialogDescription>  {/* NEW: Add this line */}
        </DialogHeader>
        {record?.auto_flagged ? (
          <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${flagColors[record.flag_color || "none"]}`}>
            <Zap className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${flagDot[record.flag_color || "none"]}`} />
                Auto-flagged
                {record.flag_color && record.flag_color !== "none" && (
                  <span className="capitalize">({record.flag_color})</span>
                )}
              </div>
              {record.flag_reason && (
                <div className="text-xs mt-0.5 opacity-80 truncate">Rule: {record.flag_reason}</div>
              )}
            </div>
          </div>
        ) : record?.flag_color && record.flag_color !== "none" ? (
          <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${flagColors[record.flag_color]}`}>
            <Flag className="w-4 h-4 shrink-0" />
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={`w-2.5 h-2.5 rounded-full ${flagDot[record.flag_color]}`} />
              Manually flagged
              <span className="capitalize">({record.flag_color})</span>
            </div>
            {record.flag_created_by && (
              <span className="ml-auto text-xs opacity-70">by {record.flag_created_by}</span>
            )}
          </div>
        ) : null}
        <div className="space-y-6 py-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">Customer Name</Label>
            <Input
              value={formData.customer_name || ""}
              onChange={(e) => handleChange("customer_name", e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} className="border-border text-muted-foreground hover:bg-muted">
            Cancel
          </Button>
          <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700 text-white">
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}