import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Edit2, Check, X, Plus, Trash2 } from "lucide-react";

const BUILT_IN_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text" },
  { key: "customer_name", label: "Customer Name", type: "text" },
  { key: "age_analysis", label: "Age Analysis", type: "text" },
  { key: "source_id", label: "Source ID", type: "text" },
  { key: "source_table", label: "Source Table", type: "text" },
  { key: "data", label: "Data", type: "object" },
  { key: "custom_field_1", label: "Legacy Custom Field 1", type: "text" },
  { key: "custom_field_2", label: "Legacy Custom Field 2", type: "text" },
  { key: "custom_field_3", label: "Legacy Custom Field 3", type: "text" },
  { key: "local_fields", label: "Dynamic Local Fields", type: "object" },
  { key: "flag_color", label: "Flag Color", type: "text" },
  { key: "flag_reason", label: "Flag Reason", type: "text" },
  { key: "note", label: "Note", type: "text" },
  { key: "synced_at", label: "Synced At", type: "date-time" },
];

async function fetchLocalCustomFields() {
  const response = await fetch("/api/custom-fields", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch custom fields");
  }

  return Array.isArray(result) ? result : [];
}

async function createLocalCustomField(data) {
  const response = await fetch("/api/custom-fields", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to create custom field");
  }

  return result;
}

async function updateLocalCustomField(id, data) {
  const response = await fetch(`/api/custom-fields/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to update custom field");
  }

  return result;
}

async function deleteLocalCustomField(id) {
  const response = await fetch(`/api/custom-fields/${id}`, {
    method: "DELETE",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to delete custom field");
  }

  return result;
}

function normalizeFieldKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export default function FieldsPage() {
  const queryClient = useQueryClient();

  const [editingFieldId, setEditingFieldId] = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [editType, setEditType] = useState("");
  const [editOptions, setEditOptions] = useState("");

  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState("text");
  const [newOptions, setNewOptions] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
  });

  const {
    data: customFields = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["customFieldConfigs"],
    queryFn: fetchLocalCustomFields,
  });

  const createFieldMutation = useMutation({
    mutationFn: createLocalCustomField,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customFieldConfigs"] });
      setNewLabel("");
      setNewKey("");
      setNewType("text");
      setNewOptions("");
      setShowCreateForm(false);
      toast.success("Custom field created successfully");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create field");
    },
  });

  const updateFieldMutation = useMutation({
    mutationFn: ({ id, data }) => updateLocalCustomField(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customFieldConfigs"] });
      setEditingFieldId(null);
      setEditLabel("");
      setEditType("");
      setEditOptions("");
      toast.success("Field updated successfully");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update field");
    },
  });

  const deleteFieldMutation = useMutation({
    mutationFn: deleteLocalCustomField,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customFieldConfigs"] });
      toast.success("Field deleted successfully");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to delete field");
    },
  });

  const handleStartEdit = (field) => {
    setEditingFieldId(field.id);
    setEditLabel(field.label);
    setEditType(field.field_type);
    setEditOptions(() => {
      if (!field.options) return "";
      try {
        const parsed = typeof field.options === "string" ? JSON.parse(field.options) : field.options;
        return Array.isArray(parsed) ? parsed.join(", ") : "";
      } catch {
        return "";
      }
    });
  };

  const handleSaveEdit = (field) => {
    if (!editLabel.trim()) {
      toast.error("Field label cannot be empty");
      return;
    }

    const payload = {
      label: editLabel.trim(),
      field_type: editType,
      options:
        editType === "select"
          ? editOptions
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
    };

    updateFieldMutation.mutate({
      id: field.id,
      data: payload,
    });
  };

  const handleCancelEdit = () => {
    setEditingFieldId(null);
    setEditLabel("");
    setEditType("");
    setEditOptions("");
  };

  const handleCreateField = () => {
    if (!newLabel.trim()) {
      toast.error("Field label is required");
      return;
    }

    const computedKey = normalizeFieldKey(newKey || newLabel);

    if (!computedKey) {
      toast.error("Field key is invalid");
      return;
    }

    createFieldMutation.mutate({
      field_key: computedKey,
      label: newLabel.trim(),
      field_type: newType,
      options:
        newType === "select"
          ? newOptions
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
      is_active: 1,
    });
  };

  const handleDeleteField = (field) => {
    if (confirm(`Delete custom field "${field.label}"?`)) {
      deleteFieldMutation.mutate(field.id);
    }
  };

  const typeColors = {
    text: "bg-blue-100 text-blue-800",
    number: "bg-purple-100 text-purple-800",
    date: "bg-green-100 text-green-800",
    "date-time": "bg-orange-100 text-orange-800",
    object: "bg-gray-100 text-gray-800",
    select: "bg-pink-100 text-pink-800",
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="mb-2 text-3xl font-bold text-[var(--text-primary)]">
              Local Database Fields
            </h1>
            <p className="text-[var(--text-secondary)]">
              Manage built-in fields and create unlimited dynamic local fields.
            </p>
          </div>

          <Button
            onClick={() => setShowCreateForm((prev) => !prev)}
            className="flex-shrink-0 bg-purple-600 hover:bg-purple-700"
          >
            <Plus className="mr-2 h-4 w-4" />
            New Field
          </Button>
        </div>

        {error && (
          <Card className="mb-6 border-rose-700 bg-rose-900/20">
            <CardContent className="p-4">
              <p className="text-sm text-rose-300">
                {error.message || "Failed to load custom fields"}
              </p>
            </CardContent>
          </Card>
        )}

        {showCreateForm && (
          <Card className="mb-6 border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <CardContent className="p-6">
              <h2 className="mb-4 text-lg font-semibold text-[var(--text-primary)]">
                Create New Local Field
              </h2>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm text-[var(--text-secondary)]">
                    Field Label
                  </label>
                  <Input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. Risk Level"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-[var(--text-secondary)]">
                    Field Key
                  </label>
                  <Input
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="e.g. risk_level"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm text-[var(--text-secondary)]">
                    Field Type
                  </label>
                  <Select value={newType} onValueChange={setNewType}>
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)]">
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                      <SelectItem value="select">Select</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {newType === "select" && (
                  <div>
                    <label className="mb-2 block text-sm text-[var(--text-secondary)]">
                      Options
                    </label>
                    <Input
                      value={newOptions}
                      onChange={(e) => setNewOptions(e.target.value)}
                      placeholder="e.g. Low, Medium, High"
                      className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]"
                    />
                  </div>
                )}
              </div>

              <div className="mt-4 flex gap-2">
                <Button
                  onClick={handleCreateField}
                  disabled={createFieldMutation.isPending}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  <Check className="mr-2 h-4 w-4" />
                  Create Field
                </Button>

                <Button
                  variant="outline"
                  onClick={() => setShowCreateForm(false)}
                  className="border-[var(--border-color)] text-[var(--text-secondary)]"
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-4">
          {isLoading ? (
            <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <CardContent className="p-8">
                <p className="text-center text-[var(--text-secondary)]">Loading fields...</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4">
                {BUILT_IN_FIELDS.map((field) => (
                  <Card
                    key={field.key}
                    className="border-[var(--border-color)] bg-[var(--bg-secondary)]"
                  >
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1">
                          <div className="mb-2 flex items-center gap-3">
                            <div className="min-w-fit font-mono text-sm text-[var(--text-secondary)]">
                              {field.key}
                            </div>
                            <Badge
                              variant="outline"
                              className="border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                            >
                              Built-in
                            </Badge>
                            <Badge className={typeColors[field.type]}>
                              {field.type}
                            </Badge>
                          </div>

                          <p className="text-lg font-semibold text-[var(--text-primary)]">
                            {field.label}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="pt-4">
                <h2 className="mb-4 text-xl font-semibold text-[var(--text-primary)]">
                  Dynamic Local Fields
                </h2>

                {customFields.length === 0 ? (
                  <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
                    <CardContent className="p-8">
                      <p className="text-center text-[var(--text-secondary)]">
                        No dynamic local fields created yet
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-4">
                    {customFields.map((field) => (
                      <Card
                        key={field.id}
                        className="border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--text-tertiary)] transition-colors"
                      >
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex-1">
                              <div className="mb-2 flex items-center gap-3">
                                <div className="min-w-fit font-mono text-sm text-[var(--text-secondary)]">
                                  {field.field_key}
                                </div>
                                <Badge className="bg-emerald-900 text-emerald-200">
                                  Custom
                                </Badge>
                                <Badge className={typeColors[field.field_type]}>
                                  {field.field_type}
                                </Badge>
                                {!field.is_active && (
                                  <Badge variant="outline" className="text-gray-400">
                                    Inactive
                                  </Badge>
                                )}
                              </div>

                              {editingFieldId === field.id ? (
                                <div className="space-y-2">
                                  <div className="flex gap-2">
                                    <Input
                                      value={editLabel}
                                      onChange={(e) => setEditLabel(e.target.value)}
                                      placeholder="Field label"
                                      className="flex-1 bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]"
                                      autoFocus
                                    />
                                    <Button
                                      size="sm"
                                      onClick={() => handleSaveEdit(field)}
                                      disabled={updateFieldMutation.isPending}
                                      className="bg-emerald-600 hover:bg-emerald-700"
                                    >
                                      <Check className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={handleCancelEdit}
                                      className="border-[var(--border-color)] text-[var(--text-secondary)]"
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>

                                  <div className="grid gap-2 md:grid-cols-2">
                                    <Select value={editType} onValueChange={setEditType}>
                                      <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent className="bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)]">
                                        <SelectItem value="text">Text</SelectItem>
                                        <SelectItem value="number">Number</SelectItem>
                                        <SelectItem value="date">Date</SelectItem>
                                        <SelectItem value="select">Select</SelectItem>
                                      </SelectContent>
                                    </Select>

                                    {editType === "select" && (
                                      <Input
                                        value={editOptions}
                                        onChange={(e) => setEditOptions(e.target.value)}
                                        placeholder="Low, Medium, High"
                                        className="bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]"
                                      />
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-lg font-semibold text-[var(--text-primary)]">
                                      {field.label}
                                    </p>
                                    {field.options && (
                                      <p className="mt-1 text-sm text-[var(--text-tertiary)]">
                                        Options:{" "}
                                        <span className="text-[var(--text-secondary)]">
                                          {(() => {
                                            try {
                                              const parsed =
                                                typeof field.options === "string"
                                                  ? JSON.parse(field.options)
                                                  : field.options;
                                              return Array.isArray(parsed)
                                                ? parsed.join(", ")
                                                : "-";
                                            } catch {
                                              return "-";
                                            }
                                          })()}
                                        </span>
                                      </p>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => handleStartEdit(field)}
                                      className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                                    >
                                      <Edit2 className="h-4 w-4" />
                                    </Button>

                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => handleDeleteField(field)}
                                      className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <Card className="mt-8 border-blue-700/50 bg-blue-900/20">
          <CardContent className="p-6">
            <p className="text-sm text-blue-300/90">
              <strong>Tip:</strong> Built-in fields remain part of the core record schema. New dynamic local
              fields are stored in <span className="font-mono">datarecord.local_fields</span> and can scale
              without adding new SQLite columns each time.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}