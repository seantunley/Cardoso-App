import { useState } from "react";
import { api } from "@/api/apiClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, X, Wand2 } from "lucide-react";
import { toast } from "sonner";
import CustomFieldCreationModal from "@/components/CustomFieldCreationModal";

const DEFAULT_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text" },
  { key: "customer_name", label: "Customer Name", type: "text" },
  { key: "age_analysis", label: "Age Analysis", type: "text" },
  { key: "notes", label: "Notes", type: "text" },
];

export default function FieldMappingSuggestions({ 
  sourceFields = [], 
  onApplySuggestions,
  isLoading = false 
}) {
  const [suggestions, setSuggestions] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const generateSuggestions = async () => {
    if (sourceFields.length === 0) {
      toast.error("No source fields available to analyze");
      return;
    }

    setIsAnalyzing(true);
    try {
      const fieldsList = sourceFields.map(f => `${f} (type: unknown)`).join(", ");
      const localFieldsList = DEFAULT_FIELDS.map(f => `${f.label} (${f.key})`).join(", ");

      // AI mapping suggestions require a connected LLM service (not yet configured).
      throw new Error("AI mapping is not available in this deployment.");
      /* eslint-disable no-unreachable */
      const result = await api.integrations?.Core?.InvokeLLM({
        prompt: `Analyze these SQL database columns and suggest mappings to local database fields.

SQL Columns: ${fieldsList}

Local Fields Available: ${localFieldsList}

For each SQL column, provide ONE of:
1. Map to an existing local field (if the column semantically matches)
2. Suggest creating a new custom field with an appropriate name and type (text, number, date, or date-time)

Prioritize meaningful matches over creating new fields when possible.

Return a JSON object with:
{
  "suggestions": [
    {
      "sourceField": "sql_column_name",
      "action": "map" | "create",
      "targetKey": "existing_field_key",  // only if action is "map"
      "customLabel": "New Field Name",      // only if action is "create"
      "fieldType": "text|number|date|date-time",
      "reason": "brief explanation"
    }
  ]
}`,
        response_json_schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sourceField: { type: "string" },
                  action: { type: "string", enum: ["map", "create"] },
                  targetKey: { type: "string" },
                  customLabel: { type: "string" },
                  fieldType: { type: "string" },
                  reason: { type: "string" }
                }
              }
            }
          }
        }
      });

      setSuggestions(result.suggestions || []);
      toast.success(`Generated ${result.suggestions?.length || 0} mapping suggestions`);
    } catch (error) {
      console.error("Error generating suggestions:", error);
      toast.error("Failed to generate mapping suggestions");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApply = () => {
    if (!suggestions || suggestions.length === 0) return;

    const mappings = {};
    const newCustomFields = [];

    suggestions.forEach(suggestion => {
      if (suggestion.action === "map" && suggestion.targetKey) {
        const targetField = DEFAULT_FIELDS.find(f => f.key === suggestion.targetKey);
        if (targetField) {
          mappings[suggestion.targetKey] = {
            sourceField: suggestion.sourceField,
            label: targetField.label,
            type: targetField.type,
            isCustom: false,
            aiSuggested: true
          };
        }
      } else if (suggestion.action === "create" && suggestion.customLabel) {
        const fieldKey = `custom_${suggestion.customLabel.toLowerCase().replace(/\s+/g, "_")}`;
        mappings[fieldKey] = {
          sourceField: suggestion.sourceField,
          label: suggestion.customLabel,
          type: suggestion.fieldType || "text",
          isCustom: true,
          aiSuggested: true
        };
        newCustomFields.push({
          label: suggestion.customLabel,
          fieldType: suggestion.fieldType || "text"
        });
      }
    });

    onApplySuggestions(mappings, newCustomFields);
    setSuggestions(null);
  };

  const handleDismiss = () => {
    setSuggestions(null);
  };

  return (
    <>
    <div className="space-y-3">
      {!suggestions ? (
        <Button
          onClick={generateSuggestions}
          disabled={isAnalyzing || sourceFields.length === 0 || isLoading}
          className="w-full bg-purple-600 hover:bg-purple-700"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Analyzing Fields...
            </>
          ) : (
            <>
              <Wand2 className="w-4 h-4 mr-2" />
              Auto-Suggest Mappings with AI
            </>
          )}
        </Button>
      ) : (
        <Card className="p-4 bg-purple-900/20 border-purple-700">
          <div className="space-y-3">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-purple-400" />
              AI Suggestions ({suggestions.length})
            </h3>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {suggestions.map((suggestion, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-gray-800 rounded border border-gray-700 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-200 truncate">
                        {suggestion.sourceField}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {suggestion.action === "map" ? "Map to" : "Create new field"}
                      </p>
                      <p className="text-sm text-purple-300 font-medium mt-1">
                        {suggestion.action === "map"
                          ? DEFAULT_FIELDS.find(f => f.key === suggestion.targetKey)?.label
                          : suggestion.customLabel}
                      </p>
                      <p className="text-xs text-gray-500 mt-1 italic">
                        {suggestion.reason}
                      </p>
                    </div>
                    {suggestion.action === "create" && (
                      <Badge variant="outline" className="text-purple-300 border-purple-600 flex-shrink-0">
                        {suggestion.fieldType}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <div className="flex gap-2">
                <Button
                  onClick={handleApply}
                  size="sm"
                  className="flex-1 bg-purple-600 hover:bg-purple-700"
                >
                  <Check className="w-4 h-4 mr-2" />
                  Apply Suggestions
                </Button>
                <Button
                  onClick={handleDismiss}
                  size="sm"
                  variant="outline"
                  className="flex-1 border-gray-700 text-gray-300 hover:bg-gray-800"
                >
                  <X className="w-4 h-4 mr-2" />
                  Dismiss
                </Button>
              </div>
              <Button
                onClick={() => setShowCreateModal(true)}
                size="sm"
                variant="outline"
                className="w-full border-amber-700 text-amber-300 hover:bg-amber-900/20"
              >
                Create Custom Field
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>

    <CustomFieldCreationModal
      open={showCreateModal}
      onClose={() => setShowCreateModal(false)}
    />
    </>
  );
}