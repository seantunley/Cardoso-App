import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Flag, Trash2, Save, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import RuleConditionBuilder from "./RuleConditionBuilder";
import RuleTester from "./RuleTester";

const flagColors = {
  red:    { bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500",    label: "Red Flag" },
  green:  { bg: "bg-green-100",  text: "text-green-700",  dot: "bg-green-500",  label: "Green Flag" },
  orange: { bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", label: "Orange Flag" },
};

export default function AutoFlagRuleForm({ rule, onSave, onDelete, isSaving, isAdmin }) {
  // New rules start expanded; existing rules start collapsed
  const [expanded, setExpanded] = useState(!rule);
  const [formData, setFormData] = useState(
    rule || {
      rule_name: "",
      conditions: [],
      logic: "AND",
      flag_color: "red",
      is_active: true,
      priority: 0,
    }
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData, rule?.id);
    if (rule) setExpanded(false); // collapse after saving edit
  };

  const flagCfg = flagColors[formData.flag_color] || flagColors.red;
  const queryClient = useQueryClient();
  const toggleActiveMutation = useMutation({
    mutationFn: async (newActive) => {
      const res = await fetch(`/api/autoflagrule/${rule?.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: newActive }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to toggle rule');
      return res.json();
    },
    onSuccess: (_, newActive) => {
      setFormData(f => ({ ...f, is_active: newActive }));
      queryClient.invalidateQueries({ queryKey: ['autoFlagRules'] });
    },
  });

  // ── Collapsed summary row ──
  if (!expanded && rule) {
    return (
      <Card className="bg-gray-800 border-gray-700">
        <CardHeader className="py-3 px-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex items-center gap-3 flex-1 min-w-0 text-left"
            >
              <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
              <div className={cn("w-2.5 h-2.5 rounded-full shrink-0", flagCfg.dot)} />
              <span className="text-white font-medium truncate">{formData.rule_name || "Unnamed Rule"}</span>
              {!formData.is_active && (
                <span className="text-xs text-gray-500 border border-gray-600 rounded px-1.5 py-0.5 shrink-0">inactive</span>
              )}
            </button>
            {isAdmin && (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- stopPropagation only (keeps the toggle from triggering the parent expand button); the checkbox inside is the real control
              <label
                className="flex items-center gap-1.5 cursor-pointer shrink-0 select-none"
                onClick={e => e.stopPropagation()}
                title={formData.is_active ? "Disable rule" : "Enable rule"}
              >
                <input
                  type="checkbox"
                  checked={!!formData.is_active}
                  onChange={e => toggleActiveMutation.mutate(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                />
                <span className="text-xs text-gray-400">{formData.is_active ? "on" : "off"}</span>
              </label>
            )}
            <div className="flex items-center gap-2 shrink-0">
              {isAdmin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setExpanded(true)}
                  className="text-gray-400 hover:text-white h-7 w-7"
                  title="Edit rule"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              )}
              {isAdmin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(rule.id)}
                  className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20 h-7 w-7"
                  title="Delete rule"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>
    );
  }

  // ── Expanded editor ──
  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center gap-3">
          {rule && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
              <div className={cn("w-2.5 h-2.5 rounded-full shrink-0", flagCfg.dot)} />
              <span className="text-white font-medium truncate">{formData.rule_name || "Unnamed Rule"}</span>
            </button>
          )}
          {!rule && (
            <div className="flex items-center gap-2 flex-1">
              <Flag className="w-5 h-5 text-gray-400" />
              <span className="text-lg font-bold text-white">New Auto-Flag Rule</span>
            </div>
          )}
          {rule && isAdmin && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onDelete(rule.id)}
              className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20 h-7 w-7 shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="builder" className="space-y-4">
          <TabsList className="bg-gray-700 border-gray-600">
            <TabsTrigger value="builder">Rule Builder</TabsTrigger>
            <TabsTrigger value="test">Test Rule</TabsTrigger>
          </TabsList>

          <TabsContent value="builder">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label className="text-gray-300">Rule Name</Label>
                <Input
                  disabled={!isAdmin}
                  value={formData.rule_name}
                  onChange={(e) => setFormData({ ...formData, rule_name: e.target.value })}
                  placeholder="e.g., 90+ Days Overdue"
                  className="bg-gray-900 border-gray-700 text-gray-100 placeholder:text-gray-500"
                  required
                />
              </div>

              <RuleConditionBuilder
                conditions={formData.conditions}
                onConditionsChange={(conditions) => setFormData({ ...formData, conditions })}
                isAdmin={isAdmin}
              />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-gray-300">Flag Color</Label>
                  <Select
                    disabled={!isAdmin}
                    value={formData.flag_color}
                    onValueChange={(val) => setFormData({ ...formData, flag_color: val })}
                  >
                    <SelectTrigger className="bg-gray-900 border-gray-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700 text-white">
                      {Object.entries(flagColors).map(([key, cfg]) => (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <div className={cn("w-3 h-3 rounded-full", cfg.dot)} />
                            {cfg.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Priority (Higher = First)</Label>
                  <Input
                    disabled={!isAdmin}
                    type="number"
                    value={formData.priority}
                    onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                    className="bg-gray-900 border-gray-700 text-gray-100"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-2">
                  <Switch
                    disabled={!isAdmin}
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                  <Label className="text-gray-300">Active</Label>
                </div>

                {isAdmin && (
                  <div className="flex gap-2">
                    {rule && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setExpanded(false)}
                        className="text-gray-400 hover:text-white"
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      type="submit"
                      disabled={isSaving}
                      className="bg-white hover:bg-gray-100 text-gray-900"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {rule ? "Update" : "Create"} Rule
                    </Button>
                  </div>
                )}
              </div>
            </form>
          </TabsContent>

          <TabsContent value="test">
            <RuleTester rule={formData} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
