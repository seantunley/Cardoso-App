import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import AutoFlagRuleForm from "../components/settings/AutoFlagRuleForm";
import { Plus, Zap, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { hasPermission } from "@/lib/permissions";

export default function Settings() {
  const queryClient = useQueryClient();
  const [showNewRule, setShowNewRule] = useState(false);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
  });

  const { data: autoFlagRules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ["autoFlagRules"],
    queryFn: () => base44.entities.AutoFlagRule.list("-priority"),
  });

  const isAdmin = currentUser?.role === "admin";
  const canManageRules = hasPermission(currentUser, "can_manage_rules");

  const createRuleMutation = useMutation({
    mutationFn: (data) => base44.entities.AutoFlagRule.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule created");
      setShowNewRule(false);
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.AutoFlagRule.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule updated");
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (id) => base44.entities.AutoFlagRule.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule deleted");
    },
  });

  const applyRulesMutation = useMutation({
     mutationFn: async (recordIds = null) => {
       const rules = await base44.entities.AutoFlagRule.list("-priority");
       const activeRules = rules.filter(r => r.is_active);
       const allRecords = await base44.entities.DataRecord.list();
       const records = recordIds ? allRecords.filter(r => recordIds.includes(r.id)) : allRecords;

       let flaggedCount = 0;
       const now = new Date().toISOString();

       for (const record of records) {
         // Skip if manually flagged (has flag_created_by and not auto_flagged)
         if (record.flag_color && record.flag_color !== "none" && record.flag_created_by && !record.auto_flagged) {
           continue;
         }

         const ageAnalysis = record.age_analysis || record.data?.age_analysis;
         if (!ageAnalysis) continue;

         const autoFlag = checkAutoFlagRulesSync(ageAnalysis, activeRules);
         if (autoFlag && autoFlag.flag_color !== record.flag_color) {
           await base44.entities.DataRecord.update(record.id, { ...autoFlag, last_checked: now });
           flaggedCount++;
         } else {
           // Update last_checked even if no flag changed
           await base44.entities.DataRecord.update(record.id, { last_checked: now });
         }
       }

       return flaggedCount;
     },
     onSuccess: (count) => {
       queryClient.invalidateQueries({ queryKey: ["records"] });
       toast.success(`Applied rules to ${count} record(s)`);
     },
   });

  const themeUpdateMutation = useMutation({
    mutationFn: (theme) => base44.auth.updateMe({ theme_preference: theme }),
    onSuccess: (_, theme) => {
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      document.documentElement.setAttribute("data-theme", theme);
      toast.success(`Switched to ${theme} mode`);
    },
  });

  const handleRuleSave = (data, existingId) => {
    if (!canManageRules) {
      toast.error("You do not have permission to modify rules");
      return;
    }
    if (existingId) {
      updateRuleMutation.mutate({ id: existingId, data });
    } else {
      createRuleMutation.mutate(data);
    }
  };

  const handleRuleDelete = (id) => {
    if (!canManageRules) {
      toast.error("You do not have permission to delete rules");
      return;
    }
    if (confirm("Delete this auto-flag rule?")) {
      deleteRuleMutation.mutate(id);
    }
  };

  const checkAutoFlagRulesSync = (ageAnalysis, rules) => {
    if (!ageAnalysis) return null;

    const evaluateCondition = (conditionType, conditionValue, conditionValueSecondary) => {
      if (['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal'].includes(conditionType)) {
        const numbersInAgeAnalysis = ageAnalysis.match(/[+\-]?\d+/g)?.map(n => parseInt(n, 10)) || [];
        const threshold = parseFloat(conditionValue);
        if (!isNaN(threshold) && numbersInAgeAnalysis.length > 0) {
          for (const num of numbersInAgeAnalysis) {
            switch (conditionType) {
              case 'greater_than': if (num > threshold) return true; break;
              case 'less_than': if (num < threshold) return true; break;
              case 'greater_or_equal': if (num >= threshold) return true; break;
              case 'less_or_equal': if (num <= threshold) return true; break;
            }
          }
        }
        return false;
      } else if (conditionType === 'range_between') {
        const numbers = ageAnalysis.match(/[+\-]?\d+/g)?.map(n => parseInt(n, 10)) || [];
        const low = parseFloat(conditionValue);
        const high = parseFloat(conditionValueSecondary);
        return numbers.some(n => n >= low && n <= high);
      } else {
        const valueLower = String(conditionValue).toLowerCase();
        const ageAnalysisLower = ageAnalysis.toLowerCase();
        switch (conditionType) {
          case 'contains': return ageAnalysisLower.includes(valueLower);
          case 'equals': return ageAnalysisLower === valueLower;
          case 'starts_with': return ageAnalysisLower.startsWith(valueLower);
          case 'ends_with': return ageAnalysisLower.endsWith(valueLower);
          default: return false;
        }
      }
    };

    for (const rule of rules) {
      let conditions = rule.conditions;
      if (typeof conditions === 'string') {
        try { conditions = JSON.parse(conditions); } catch { conditions = []; }
      }
      if (!Array.isArray(conditions) || conditions.length === 0) continue;

      const logic = rule.logic || 'AND';
      const results = conditions.map(c =>
        evaluateCondition(c.condition_type, c.condition_value, c.condition_value_secondary)
      );

      const matches = logic === 'OR'
        ? results.some(Boolean)
        : results.every(Boolean);

      if (matches) {
        return {
          flag_color: rule.flag_color,
          flag_reason: `Auto-flagged: ${rule.rule_name}`,
          auto_flagged: true,
        };
      }
    }

    return null;
  };

  return (
     <div className="min-h-screen bg-[var(--bg-primary)]">
       <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-8">
         {/* Header */}
         <div>
           <div>
             <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
               Settings
             </h1>
             <p className="text-[var(--text-secondary)] mt-1">
               Manage app preferences and auto-flag rules
             </p>
           </div>
         </div>

         {/* Theme Selector */}
         <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
           <CardHeader>
             <CardTitle className="flex items-center gap-2 text-[var(--text-primary)]">
               <Sun className="w-5 h-5" />
               Theme
             </CardTitle>
           </CardHeader>
           <CardContent>
             <div className="flex gap-3">
               <Button
                 onClick={() => themeUpdateMutation.mutate("light")}
                 variant={currentUser?.theme_preference === "light" ? "default" : "outline"}
                 className={currentUser?.theme_preference === "light" ? "bg-white text-gray-900 hover:bg-gray-100" : "border-[var(--border-color)] text-gray-900"}
                 disabled={themeUpdateMutation.isPending}
               >
                 <Sun className="w-4 h-4 mr-2" />
                 Light Mode
               </Button>
               <Button
                 onClick={() => themeUpdateMutation.mutate("dark")}
                 variant={currentUser?.theme_preference === "dark" ? "default" : "outline"}
                 className={currentUser?.theme_preference === "dark" ? "bg-gray-900 text-white hover:bg-gray-800" : "border-[var(--border-color)] text-[var(--text-primary)]"}
                 disabled={themeUpdateMutation.isPending}
               >
                 <Moon className="w-4 h-4 mr-2" />
                 Dark Mode
               </Button>
             </div>
           </CardContent>
         </Card>

        {/* Auto-Flag Rules Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-amber-900/30 to-orange-900/30 rounded-lg">
                <Zap className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-[var(--text-primary)]">Auto-Flag Rules</h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  Automatically flag customers based on age analysis values
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {canManageRules && (
                <Button
                  onClick={() => applyRulesMutation.mutate()}
                  disabled={applyRulesMutation.isPending || autoFlagRules.length === 0}
                  variant="outline"
                  className="border-white text-gray-900 bg-white hover:bg-gray-100"
                >
                  {applyRulesMutation.isPending ? (
                    <>
                      <span className="animate-spin mr-2">⏳</span>
                      Applying...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 mr-2" />
                      Apply Now
                    </>
                  )}
                </Button>
              )}
              {canManageRules && (
                <Button
                  onClick={() => setShowNewRule(true)}
                  className="bg-white hover:bg-gray-100 text-gray-900"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Rule
                </Button>
              )}
            </div>
          </div>

          {showNewRule && canManageRules && (
            <AutoFlagRuleForm
              onSave={handleRuleSave}
              onDelete={() => setShowNewRule(false)}
              isSaving={createRuleMutation.isPending}
              isAdmin={canManageRules}
            />
          )}

          {rulesLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="h-48 bg-[var(--bg-secondary)] rounded-2xl animate-pulse"
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {autoFlagRules.map((rule) => (
                <AutoFlagRuleForm
                  key={rule.id}
                  rule={rule}
                  onSave={handleRuleSave}
                  onDelete={handleRuleDelete}
                  isSaving={updateRuleMutation.isPending || deleteRuleMutation.isPending}
                  isAdmin={canManageRules}
                />
              ))}
              {autoFlagRules.length === 0 && !showNewRule && (
                <div className="text-center py-12 bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-color)] border-dashed">
                  <Zap className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-3" />
                  <p className="text-[var(--text-secondary)]">No auto-flag rules yet</p>
                  <p className="text-sm text-[var(--text-tertiary)] mt-1">
                    Create rules to automatically flag customers based on their age analysis
                  </p>
                </div>
              )}
            </div>
          )}
        </div>


      </div>
    </div>
  );
}