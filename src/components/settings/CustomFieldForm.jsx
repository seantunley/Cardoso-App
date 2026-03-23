import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Save, Plus, X, Loader2, Tag } from "lucide-react";
import { cn } from "@/lib/utils";

export default function CustomFieldForm({ config, onSave, isSaving }) {
  const [formData, setFormData] = useState({
    field_key: config?.field_key || "custom_field_1",
    label: "",
    field_type: "text",
    options: [],
    is_active: true,
  });
  const [newOption, setNewOption] = useState("");

  useEffect(() => {
    if (config) {
      setFormData({
        field_key: config.field_key,
        label: config.label || "",
        field_type: config.field_type || "text",
        options: config.options || [],
        is_active: config.is_active !== false,
      });
    }
  }, [config]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData, config?.id);
  };

  const addOption = () => {
    if (newOption.trim() && !formData.options.includes(newOption.trim())) {
      setFormData({
        ...formData,
        options: [...formData.options, newOption.trim()],
      });
      setNewOption("");
    }
  };

  const removeOption = (opt) => {
    setFormData({
      ...formData,
      options: formData.options.filter((o) => o !== opt),
    });
  };

  const fieldLabels = {
    custom_field_1: "Custom Field 1",
    custom_field_2: "Custom Field 2",
    custom_field_3: "Custom Field 3",
  };

  return (
    <Card className="border-slate-200/60">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-100 rounded-lg">
              <Tag className="w-4 h-4 text-slate-600" />
            </div>
            <div>
              <CardTitle className="text-lg font-semibold">
                {fieldLabels[formData.field_key]}
              </CardTitle>
              <p className="text-sm text-slate-500 mt-0.5">
                {formData.label || "Not configured"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor={`active-${formData.field_key}`} className="text-sm text-slate-500">
              Active
            </Label>
            <Switch
              id={`active-${formData.field_key}`}
              checked={formData.is_active}
              onCheckedChange={(val) => setFormData({ ...formData, is_active: val })}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-700">Display Label</Label>
              <Input
                value={formData.label}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                placeholder="e.g., Category, Status, Priority"
                required
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium text-slate-700">Field Type</Label>
              <Select
                value={formData.field_type}
                onValueChange={(val) => setFormData({ ...formData, field_type: val })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="select">Dropdown Select</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="date">Date</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {formData.field_type === "select" && (
            <div className="space-y-3">
              <Label className="text-sm font-medium text-slate-700">Options</Label>
              <div className="flex gap-2">
                <Input
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  placeholder="Add an option"
                  onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addOption())}
                />
                <Button type="button" variant="outline" onClick={addOption}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 min-h-[40px] p-3 bg-slate-50 rounded-lg border border-slate-200">
                {formData.options.length === 0 ? (
                  <span className="text-sm text-slate-400">No options added yet</span>
                ) : (
                  formData.options.map((opt) => (
                    <Badge
                      key={opt}
                      variant="secondary"
                      className="bg-white border border-slate-200 gap-1 pr-1"
                    >
                      {opt}
                      <button
                        type="button"
                        onClick={() => removeOption(opt)}
                        className="ml-1 hover:bg-slate-100 rounded p-0.5"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button type="submit" disabled={isSaving} className="bg-slate-900 hover:bg-slate-800">
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              <Save className="w-4 h-4 mr-2" />
              Save Configuration
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}