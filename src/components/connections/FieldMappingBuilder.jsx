import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { X, ArrowRight } from "lucide-react";
import CustomFieldCreationModal from "../CustomFieldCreationModal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const FALLBACK_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text" },
  { key: "customer_name", label: "Customer Name", type: "text" },
  { key: "age_analysis", label: "Age Analysis", type: "text" },
  { key: "note", label: "Notes", type: "text" },
  { key: "custom_field_1", label: "Custom Field 1", type: "text", isCustom: true },
  { key: "custom_field_2", label: "Custom Field 2", type: "text", isCustom: true },
  { key: "custom_field_3", label: "Custom Field 3", type: "text", isCustom: true },
];

const SYNC_MODES = [
  { key: "sync", label: "Always sync" },
  { key: "sync-if-empty", label: "Sync if empty" },
  { key: "local-only", label: "Local only" },
];

export default function FieldMappingBuilder({
  fieldMappings = {},
  availableFields = [],
  localFields = [],
  onMappingsChange,
}) {
  const [selectedSourceField, setSelectedSourceField] = useState("");
  const [selectedTargetField, setSelectedTargetField] = useState("");
  const [selectedMode, setSelectedMode] = useState("sync");
  const [showCreateModal, setShowCreateModal] = useState(false);

  const existingFields = localFields.length > 0 ? localFields : FALLBACK_FIELDS;

  const mappedSourceFields = Object.entries(fieldMappings)
    .map(([_, mapping]) => mapping?.sourceField)
    .filter(Boolean);

  const unmappedSourceFields = availableFields.filter(
    (f) => !mappedSourceFields.includes(f)
  );

  const mappedTargetFields = Object.keys(fieldMappings);

  const availableTargetFieldsForNewMapping = existingFields.filter(
    (field) => !mappedTargetFields.includes(field.key)
  );

  const handleAddMapping = () => {
    if (!selectedSourceField || !selectedTargetField) return;

    const targetField = existingFields.find((f) => f.key === selectedTargetField);
    if (!targetField) return;

    onMappingsChange({
      ...fieldMappings,
      [selectedTargetField]: {
        sourceField: selectedSourceField,
        label: targetField.label,
        type: targetField.type,
        isCustom: targetField.isBuiltIn ? false : !!targetField.isCustom || true,
        mode: selectedMode,
      },
    });

    setSelectedSourceField("");
    setSelectedTargetField("");
    setSelectedMode("sync");
  };

  const handleRemoveMapping = (fieldKey) => {
    const next = { ...fieldMappings };
    delete next[fieldKey];
    onMappingsChange(next);
  };

  const handleModeChange = (fieldKey, mode) => {
    onMappingsChange({
      ...fieldMappings,
      [fieldKey]: {
        ...fieldMappings[fieldKey],
        mode,
      },
    });
  };

  const handleSourceFieldChange = (fieldKey, sourceField) => {
    onMappingsChange({
      ...fieldMappings,
      [fieldKey]: {
        ...fieldMappings[fieldKey],
        sourceField,
      },
    });
  };

  const getAvailableSourceFieldsForMapping = (fieldKey) => {
    const currentSource = fieldMappings[fieldKey]?.sourceField;

    return availableFields.filter((field) => {
      if (field === currentSource) return true;

      return !Object.entries(fieldMappings).some(
        ([otherKey, mapping]) =>
          otherKey !== fieldKey && mapping?.sourceField === field
      );
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-gray-300">Active Field Mappings</Label>

        {Object.entries(fieldMappings).length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">
            No field mappings yet. Create mappings below.
          </p>
        ) : (
          <div className="space-y-2">
            {Object.entries(fieldMappings).map(([localKey, mapping]) => {
              const localField = existingFields.find((f) => f.key === localKey);
              const availableSourceOptions = getAvailableSourceFieldsForMapping(localKey);

              return (
                <div
                  key={localKey}
                  className="space-y-3 rounded-lg border border-gray-700 bg-gray-800 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-300">
                          {mapping.sourceField}
                        </p>
                        <p className="text-xs text-gray-500">SQL column</p>
                      </div>

                      <ArrowRight className="h-4 w-4 flex-shrink-0 text-gray-600" />

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">
                          {localField?.label || mapping.label || localKey}
                        </p>
                        <p className="text-xs text-gray-500">
                          {localField?.isBuiltIn
                            ? "Built-in field"
                            : mapping.isCustom
                              ? "Custom/local field"
                              : "Built-in field"}
                        </p>
                      </div>
                    </div>

                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemoveMapping(localKey)}
                      className="flex-shrink-0 text-gray-400 hover:bg-rose-900/20 hover:text-rose-400"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="mb-1 block text-xs text-gray-400">
                        Source field
                      </Label>
                      <Select
                        value={mapping.sourceField || ""}
                        onValueChange={(value) => handleSourceFieldChange(localKey, value)}
                      >
                        <SelectTrigger className="h-9 border-gray-700 bg-gray-900 text-sm text-white">
                          <SelectValue placeholder="Select SQL field" />
                        </SelectTrigger>
                        <SelectContent className="border-gray-700 bg-gray-800 text-white">
                          {availableSourceOptions.map((field) => (
                            <SelectItem key={field} value={field}>
                              {field}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="mb-1 block text-xs text-gray-400">
                        Sync behavior
                      </Label>
                      <Select
                        value={mapping.mode || "sync"}
                        onValueChange={(value) => handleModeChange(localKey, value)}
                      >
                        <SelectTrigger className="h-9 border-gray-700 bg-gray-900 text-sm text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-gray-700 bg-gray-800 text-white">
                          {SYNC_MODES.map((mode) => (
                            <SelectItem key={mode.key} value={mode.key}>
                              {mode.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {unmappedSourceFields.length > 0 && availableTargetFieldsForNewMapping.length > 0 && (
        <div className="space-y-3 border-t border-gray-800 pt-4">
          <Label className="text-gray-300">Create New Mapping</Label>

          <div className="grid grid-cols-3 gap-2">
            <Select value={selectedSourceField} onValueChange={setSelectedSourceField}>
              <SelectTrigger className="h-9 border-gray-700 bg-gray-900 text-sm text-white">
                <SelectValue placeholder="Select SQL field" />
              </SelectTrigger>
              <SelectContent className="border-gray-700 bg-gray-800 text-white">
                {unmappedSourceFields.map((field) => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedTargetField} onValueChange={setSelectedTargetField}>
              <SelectTrigger className="h-9 border-gray-700 bg-gray-900 text-sm text-white">
                <SelectValue placeholder="Target field" />
              </SelectTrigger>
              <SelectContent className="border-gray-700 bg-gray-800 text-white">
                {availableTargetFieldsForNewMapping.map((field) => (
                  <SelectItem key={field.key} value={field.key}>
                    {field.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedMode} onValueChange={setSelectedMode}>
              <SelectTrigger className="h-9 border-gray-700 bg-gray-900 text-sm text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-gray-700 bg-gray-800 text-white">
                {SYNC_MODES.map((mode) => (
                  <SelectItem key={mode.key} value={mode.key}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            onClick={handleAddMapping}
            disabled={!selectedSourceField || !selectedTargetField}
            variant="outline"
            size="sm"
            className="w-full border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Create Mapping
          </Button>

          <Button
            type="button"
            onClick={() => setShowCreateModal(true)}
            variant="outline"
            size="sm"
            className="w-full border-purple-700 text-purple-300 hover:bg-purple-900/20 hover:text-purple-200"
          >
            Configure Custom Field Labels
          </Button>
        </div>
      )}

      {unmappedSourceFields.length === 0 && Object.keys(fieldMappings).length > 0 && (
        <Card className="border-emerald-700 bg-emerald-900/20 p-3">
          <p className="text-xs text-emerald-300">
            All available fields are mapped.
          </p>
        </Card>
      )}

      <CustomFieldCreationModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </div>
  );
}