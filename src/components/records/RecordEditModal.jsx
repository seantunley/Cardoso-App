import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";  // NEW: Import DialogDescription
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";

export default function RecordEditModal({ open, onClose, record, onSave }) {
  const [formData, setFormData] = useState({});
  const { data: configs = [] } = useQuery({
    queryKey: ["customFieldConfigs"],
    queryFn: () => base44.entities.CustomFieldConfig.list(),
  });

  useEffect(() => {
    if (record) {
      setFormData({
        customer_name: record.customer_name || "",
        custom_field_1: record.custom_field_1 || "",
        custom_field_2: record.custom_field_2 || "",
        custom_field_3: record.custom_field_3 || "",
      });
    }
  }, [record]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    onSave({ ...record, ...formData });
    onClose();
  };

  const renderField = (config) => {
    if (!config.is_active) return null;
    const value = formData[config.field_key] || "";
    switch (config.field_type) {
      case "text":
        return (
          <div key={config.id} className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">{config.label}</Label>
            <Input
              value={value}
              onChange={(e) => handleChange(config.field_key, e.target.value)}
              className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-500"
            />
          </div>
        );
      case "select":
        // NEW: Parse options if it's a JSON string from DB
        let parsedOptions = Array.isArray(config.options) ? config.options : [];
        if (typeof config.options === 'string') {
          try {
            parsedOptions = JSON.parse(config.options);
          } catch (e) {
            console.error(`Failed to parse options for ${config.field_key}:`, e);
            parsedOptions = [];
          }
        }
        return (
          <div key={config.id} className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">{config.label}</Label>
            <Select value={value} onValueChange={(val) => handleChange(config.field_key, val)}>
              <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-white">
                {parsedOptions.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      case "number":
        return (
          <div key={config.id} className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">{config.label}</Label>
            <Input
              type="number"
              value={value}
              onChange={(e) => handleChange(config.field_key, e.target.value)}
              className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-500"
            />
          </div>
        );
      case "date":
        return (
          <div key={config.id} className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">{config.label}</Label>
            <Input
              type="date"
              value={value}
              onChange={(e) => handleChange(config.field_key, e.target.value)}
              className="bg-gray-800 border-gray-700 text-white"
            />
          </div>
        );
      default:
        return null;
    }
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="bg-gray-900 border-gray-700 text-white">
        <DialogHeader>
          <DialogTitle>Edit Record</DialogTitle>
          <DialogDescription>Modify the customer name and custom fields below.</DialogDescription>  {/* NEW: Add this line */}
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-gray-200">Customer Name</Label>
            <Input
              value={formData.customer_name || ""}
              onChange={(e) => handleChange("customer_name", e.target.value)}
              className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-500"
            />
          </div>
          {configs.map((config) => renderField(config))}
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} className="border-gray-700 text-gray-300 hover:bg-gray-800">
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