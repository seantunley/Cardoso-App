import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Flag, Trash2, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import RuleConditionBuilder from "./RuleConditionBuilder";
import RuleTester from "./RuleTester";

const flagColors = {
  red: { bg: "bg-red-100", text: "text-red-700", label: "Red Flag" },
  green: { bg: "bg-green-100", text: "text-green-700", label: "Green Flag" },
  orange: { bg: "bg-orange-100", text: "text-orange-700", label: "Orange Flag" },
};

export default function AutoFlagRuleForm({ rule, onSave, onDelete, isSaving, isAdmin }) {
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
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg text-white flex items-center gap-2">
            <Flag className="w-5 h-5 text-gray-400" />
            {rule ? "Edit Auto-Flag Rule" : "New Auto-Flag Rule"}
          </CardTitle>
          {rule && isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(rule.id)}
              className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20"
            >
              <Trash2 className="w-4 h-4" />
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
                  onChange={(e) =>
                    setFormData({ ...formData, rule_name: e.target.value })
                  }
                  placeholder="e.g., 90+ Days Overdue"
                  className="bg-gray-900 border-gray-700 text-gray-100 placeholder:text-gray-500"
                  required
                />
              </div>

              <RuleConditionBuilder
                conditions={formData.conditions}
                logic={formData.logic}
                onConditionsChange={(conditions) =>
                  setFormData({ ...formData, conditions })
                }
                onLogicChange={(logic) =>
                  setFormData({ ...formData, logic })
                }
                isAdmin={isAdmin}
              />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-gray-300">Flag Color</Label>
                  <Select
                    disabled={!isAdmin}
                    value={formData.flag_color}
                    onValueChange={(val) =>
                      setFormData({ ...formData, flag_color: val })
                    }
                  >
                    <SelectTrigger className="bg-gray-900 border-gray-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700 text-white">
                      {Object.entries(flagColors).map(([key, config]) => (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                "w-3 h-3 rounded-full",
                                key === "red" && "bg-red-500",
                                key === "green" && "bg-green-500",
                                key === "orange" && "bg-orange-500"
                              )}
                            />
                            {config.label}
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
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        priority: parseInt(e.target.value) || 0,
                      })
                    }
                    className="bg-gray-900 border-gray-700 text-gray-100"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-2">
                  <Switch
                    disabled={!isAdmin}
                    checked={formData.is_active}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, is_active: checked })
                    }
                  />
                  <Label className="text-gray-300">Active</Label>
                </div>

                {isAdmin && (
                  <Button
                    type="submit"
                    disabled={isSaving}
                    className="bg-white hover:bg-gray-100 text-gray-900"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    {rule ? "Update" : "Create"} Rule
                  </Button>
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