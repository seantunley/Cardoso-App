import { useState, useEffect } from "react";
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
import { Loader2, Database, X, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import FieldMappingBuilder from "./FieldMappingBuilder";
import FieldMappingSuggestions from "./FieldMappingSuggestions";

async function fetchLocalCustomFields() {
  const response = await fetch("/api/custom-fields", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to load custom fields");
  }

  return Array.isArray(result) ? result : [];
}

async function runLocalImport(connectionId) {
  const response = await fetch(`/api/import/${connectionId}`, {
    method: "POST",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Import failed");
  }

  return result;
}

const BUILT_IN_LOCAL_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text", isBuiltIn: true },
  { key: "customer_name", label: "Customer Name", type: "text", isBuiltIn: true },
  { key: "age_analysis", label: "Age Analysis", type: "text", isBuiltIn: true },
  { key: "note", label: "Note", type: "text", isBuiltIn: true },
  { key: "flag_color", label: "Flag Color", type: "text", isBuiltIn: true },
  { key: "flag_reason", label: "Flag Reason", type: "text", isBuiltIn: true },
  { key: "custom_field_1", label: "Legacy Custom Field 1", type: "text", isBuiltIn: true },
  { key: "custom_field_2", label: "Legacy Custom Field 2", type: "text", isBuiltIn: true },
  { key: "custom_field_3", label: "Legacy Custom Field 3", type: "text", isBuiltIn: true },
];

export default function ConnectionModal({ connection, open, onClose, onSave, isSaving }) {
  const [formData, setFormData] = useState({
    name: "",
    host: "",
    port: 1433,
    database_name: "",
    username: "",
    password: "",
    table_configs: [],
    join_configuration: {},
    field_mappings: {},
    status: "inactive",
  });

  const [availableTables, setAvailableTables] = useState([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [availableFields, setAvailableFields] = useState({});
  const [connectionTestStatus, setConnectionTestStatus] = useState(null);
  const [selectedTableForMapping, setSelectedTableForMapping] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [customLocalFields, setCustomLocalFields] = useState([]);

  const allLocalFields = [
    ...BUILT_IN_LOCAL_FIELDS,
    ...customLocalFields.map((field) => ({
      key: field.field_key,
      label: field.label,
      type: field.field_type,
      options: field.options,
      isBuiltIn: false,
    })),
  ];

  const loadCustomLocalFields = async () => {
    try {
      const fields = await fetchLocalCustomFields();
      setCustomLocalFields(fields);
    } catch (error) {
      console.error("Failed to load local custom fields:", error);
    }
  };

  const loadExistingConnectionFields = async (conn) => {
    if (!conn?.host || !conn?.database_name || !conn?.username) return;
    if (!conn?.encrypted_password) return;

    try {
      setLoadingTables(true);

      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          host: conn.host,
          port: conn.port || 1433,
          database_name: conn.database_name,
          username: conn.username,
          password: conn.encrypted_password,
        }),
      });

      const text = await response.text();

      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }

      if (!response.ok) {
        throw new Error(data.error || data.message || "Failed to load fields");
      }

      setAvailableTables(data.tables || []);
      setAvailableFields(data.fields || {});

      if (!selectedTableForMapping && data.tables?.length > 0) {
        setSelectedTableForMapping(data.tables[0]);
      }
    } catch (error) {
      console.error("Failed to load existing connection fields:", error);
    } finally {
      setLoadingTables(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadCustomLocalFields();
    }
  }, [open]);

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        host: connection.host || "",
        port: connection.port || 1433,
        database_name: connection.database_name || "",
        username: connection.username || "",
        password: "",
        table_configs:
          typeof connection.table_configs === "string"
            ? JSON.parse(connection.table_configs || "[]")
            : connection.table_configs || [],
        join_configuration:
          typeof connection.join_configuration === "string"
            ? JSON.parse(connection.join_configuration || "{}")
            : connection.join_configuration || {},
        field_mappings: (() => {
          const raw = typeof connection.field_mappings === "string"
            ? JSON.parse(connection.field_mappings || "{}")
            : connection.field_mappings || {};
          // Migrate legacy flat format { localKey: { sourceField } } to per-table
          // Per-table format: { tableName: { localKey: { sourceField } } }
          const isFlat = Object.keys(raw).length > 0 &&
            Object.values(raw).some((v) => v && typeof v === "object" && v.sourceField);
          if (isFlat) {
            const tableConfigs = typeof connection.table_configs === "string"
              ? JSON.parse(connection.table_configs || "[]")
              : connection.table_configs || [];
            // Assign flat mappings to all tables as a best-effort migration
            const migrated = {};
            for (const t of tableConfigs) {
              migrated[t.table_name] = raw;
            }
            return migrated;
          }
          return raw;
        })(),
        status: connection.status || "inactive",
      });

      if (connection.table_configs) {
        const tableConfigs =
          typeof connection.table_configs === "string"
            ? JSON.parse(connection.table_configs)
            : connection.table_configs;

        setAvailableTables(tableConfigs.map((t) => t.table_name));

        if (tableConfigs.length > 0) {
          setSelectedTableForMapping(tableConfigs[0].table_name);
        }
      }

      loadExistingConnectionFields(connection);
    } else {
      setFormData({
        name: "",
        host: "",
        port: 1433,
        database_name: "",
        username: "",
        password: "",
        table_configs: [],
        join_configuration: {},
        field_mappings: {},
        status: "inactive",
      });
      setAvailableTables([]);
      setAvailableFields({});
      setConnectionTestStatus(null);
      setSelectedTableForMapping(null);
    }
  }, [connection, open]);

  const handleTestConnection = async () => {
    if (!formData.host || !formData.database_name || !formData.username || !formData.password) {
      toast.error("Please fill in all connection details including password");
      setConnectionTestStatus("error");
      return;
    }

    setLoadingTables(true);
    setConnectionTestStatus(null);

    try {
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          host: formData.host,
          port: formData.port || 1433,
          database_name: formData.database_name,
          username: formData.username,
          password: formData.password,
        }),
      });

      const text = await response.text();

      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }

      if (!response.ok) {
        throw new Error(data.error || data.message || "Test failed");
      }

      setAvailableTables(data.tables || []);
      setAvailableFields(data.fields || {});
      setConnectionTestStatus("success");
      toast.success(`Connected — ${data.tables?.length || 0} tables found`);

      if (!selectedTableForMapping && data.tables?.length > 0) {
        setSelectedTableForMapping(data.tables[0]);
      }
    } catch (error) {
      setConnectionTestStatus("error");
      toast.error(`Connection failed: ${error.message || "Unable to connect to database"}`);
    } finally {
      setLoadingTables(false);
    }
  };

  const addTableConfig = (tableName) => {
    if (formData.table_configs.some((t) => t.table_name === tableName)) {
      return;
    }

    setFormData({
      ...formData,
      table_configs: [
        ...formData.table_configs,
        {
          table_name: tableName,
          selected_fields: [],
          index_field: "",
        },
      ],
    });
  };

  const removeTableConfig = (tableName) => {
    const nextMappings = { ...formData.field_mappings };
    delete nextMappings[tableName];
    setFormData({
      ...formData,
      table_configs: formData.table_configs.filter((t) => t.table_name !== tableName),
      field_mappings: nextMappings,
    });
  };

  const updateTableConfig = (tableName, updates) => {
    setFormData({
      ...formData,
      table_configs: formData.table_configs.map((t) =>
        t.table_name === tableName ? { ...t, ...updates } : t
      ),
    });
  };

  const toggleField = (tableName, field) => {
    const tableConfig = formData.table_configs.find((t) => t.table_name === tableName);
    if (!tableConfig) return;

    const hasField = tableConfig.selected_fields.includes(field);

    updateTableConfig(tableName, {
      selected_fields: hasField
        ? tableConfig.selected_fields.filter((f) => f !== field)
        : [...tableConfig.selected_fields, field],
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (formData.table_configs.length === 0) {
      toast.error("Please add at least one table");
      return;
    }

    const missingIndex = formData.table_configs.find((t) => !t.index_field);
    if (missingIndex) {
      toast.error(`Please select index field for table: ${missingIndex.table_name}`);
      return;
    }

    const dataToSave = {
      ...formData,
      encrypted_password: formData.password
        ? formData.password
        : connection?.encrypted_password || "",
      table_configs: JSON.stringify(formData.table_configs),
      join_configuration: JSON.stringify(formData.join_configuration),
      field_mappings: JSON.stringify(formData.field_mappings || {}),
    };

    delete dataToSave.password;

    onSave(dataToSave, connection?.id);
  };

  const handleImport = async () => {
    if (!connection?.id) return;

    setIsImporting(true);

    try {
      const result = await runLocalImport(connection.id);
      toast.success(result.message || `Import completed - ${result.imported || 0} records added`);
    } catch (e) {
      console.error("Import failed:", e);
      toast.error("Import failed: " + (e.message || "Unknown error"));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-gray-900 border-gray-700">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gray-800 rounded-lg">
              <Database className="w-5 h-5 text-gray-400" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold text-white">
                {connection ? "Edit Connection" : "New Connection"}
              </DialogTitle>
              <p className="text-sm text-gray-400 mt-0.5">
                Configure your SQL database connection
              </p>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-gray-300">Connection Name</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Main Branch DB"
              className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-2">
              <Label className="text-sm font-medium text-gray-300">Host</Label>
              <Input
                value={formData.host}
                onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                placeholder="localhost or IP address"
                className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
                required
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-300">Port</Label>
              <Input
                type="number"
                value={formData.port}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    port: e.target.value === "" ? "" : parseInt(e.target.value, 10),
                  })
                }
                placeholder="1433"
                className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-300">Database</Label>
              <Input
                value={formData.database_name}
                onChange={(e) => setFormData({ ...formData, database_name: e.target.value })}
                placeholder="Database name"
                className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
                required
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-300">Username</Label>
              <Input
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="DB username"
                className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-gray-300">Password</Label>
            <Input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              placeholder="••••••••"
              className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
              required={!connection}
            />
            {connection && (
              <p className="text-xs text-gray-400">Leave blank to keep existing password</p>
            )}
          </div>

          <div className="pt-4 border-t border-gray-800">
            <Button
              type="button"
              onClick={handleTestConnection}
              disabled={loadingTables}
              className={`w-full ${
                connectionTestStatus === "success"
                  ? "border-green-700 text-green-400 hover:bg-green-900/20"
                  : connectionTestStatus === "error"
                    ? "border-red-700 text-red-400 hover:bg-red-900/20"
                    : "border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {loadingTables ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Testing Connection...
                </>
              ) : connectionTestStatus === "success" ? (
                <>
                  <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Connection Successful
                </>
              ) : connectionTestStatus === "error" ? (
                <>
                  <X className="w-4 h-4 mr-2" />
                  Connection Failed
                </>
              ) : (
                <>
                  <Database className="w-4 h-4 mr-2" />
                  Test Connection & Load Tables
                </>
              )}
            </Button>
          </div>

          {availableTables.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-gray-800">
              <Label className="text-gray-300">Available Tables - Click to Add</Label>
              <div className="flex flex-wrap gap-2">
                {availableTables.map((table) => {
                  const isSelected = formData.table_configs.some((t) => t.table_name === table);

                  return (
                    <Button
                      key={table}
                      type="button"
                      size="sm"
                      variant={isSelected ? "default" : "outline"}
                      className={
                        isSelected
                          ? "bg-white text-gray-900"
                          : "border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
                      }
                      onClick={() => {
                        if (isSelected) {
                          removeTableConfig(table);
                        } else {
                          addTableConfig(table);
                        }
                      }}
                    >
                      {table}
                      {isSelected && <X className="w-3 h-3 ml-2" />}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {formData.table_configs.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-gray-800">
              <Label className="text-gray-300">Select Table for Field Mapping</Label>
              <Select value={selectedTableForMapping || ""} onValueChange={setSelectedTableForMapping}>
                <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                  <SelectValue placeholder="Select a table" />
                </SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700 text-white">
                  {formData.table_configs.map((tableConfig) => (
                    <SelectItem key={tableConfig.table_name} value={tableConfig.table_name}>
                      {tableConfig.table_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedTableForMapping && availableFields[selectedTableForMapping] && (
                <div className="space-y-4">
                  <FieldMappingSuggestions
                    sourceFields={availableFields[selectedTableForMapping] || []}
                    localFields={allLocalFields}
                    onApplySuggestions={(mappings) => {
                      setFormData({
                        ...formData,
                        field_mappings: {
                          ...formData.field_mappings,
                          [selectedTableForMapping]: {
                            ...(formData.field_mappings?.[selectedTableForMapping] || {}),
                            ...mappings,
                          },
                        },
                      });
                    }}
                    isLoading={loadingTables}
                  />

                  <div className="p-4 bg-gray-800 rounded-lg border border-gray-700">
                    <FieldMappingBuilder
                      fieldMappings={formData.field_mappings?.[selectedTableForMapping] || {}}
                      availableFields={availableFields[selectedTableForMapping] || []}
                      localFields={allLocalFields}
                      onMappingsChange={(mappings) => {
                        setFormData({
                          ...formData,
                          field_mappings: {
                            ...formData.field_mappings,
                            [selectedTableForMapping]: mappings,
                          },
                        });
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {formData.table_configs.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-gray-800">
              <Label className="text-gray-300">
                Table Configuration ({formData.table_configs.length} selected)
              </Label>

              <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
                {formData.table_configs.map((tableConfig) => {
                  const fields = availableFields[tableConfig.table_name] || [];

                  return (
                    <Card key={tableConfig.table_name} className="p-4 border-gray-700 bg-gray-800">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-white">{tableConfig.table_name}</h4>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => removeTableConfig(tableConfig.table_name)}
                            className="text-gray-400 hover:text-white hover:bg-gray-700"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs text-gray-400">Index/Primary Key Field *</Label>
                          <Select
                            value={tableConfig.index_field}
                            onValueChange={(val) =>
                              updateTableConfig(tableConfig.table_name, { index_field: val })
                            }
                          >
                            <SelectTrigger className="h-9 bg-gray-900 border-gray-700 text-gray-100">
                              <SelectValue placeholder="Select index field for joins" />
                            </SelectTrigger>
                            <SelectContent className="bg-gray-800 border-gray-700 text-white">
                              {fields.map((field) => (
                                <SelectItem key={field} value={field}>
                                  {field}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs text-gray-400">Fields to Import</Label>
                          <div className="flex flex-wrap gap-2 p-3 bg-gray-900 rounded-lg border border-gray-700">
                            {fields.map((field) => {
                              const isSelected = tableConfig.selected_fields.includes(field);

                              return (
                                <Badge
                                  key={field}
                                  variant={isSelected ? "default" : "outline"}
                                  className={`cursor-pointer transition-colors ${
                                    isSelected
                                      ? "bg-white text-gray-900"
                                      : "border-gray-700 text-gray-300 hover:bg-gray-800"
                                  }`}
                                  onClick={() => toggleField(tableConfig.table_name, field)}
                                >
                                  {field}
                                </Badge>
                              );
                            })}
                          </div>
                          <p className="text-xs text-gray-400">
                            {tableConfig.selected_fields.length} fields selected
                          </p>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 pt-4 border-t border-gray-800">
            <Label className="text-sm font-medium text-gray-300">Status</Label>
            <Select
              value={formData.status}
              onValueChange={(val) => setFormData({ ...formData, status: val })}
            >
              <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-white">
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="testing">Testing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
            >
              Cancel
            </Button>

            <Button
              type="submit"
              disabled={isSaving}
              className="bg-white hover:bg-gray-100 text-gray-900"
            >
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {connection ? "Update" : "Create"} Connection
            </Button>

            {connection && (
              <Button
                type="button"
                onClick={handleImport}
                disabled={isImporting}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {isImporting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCcw className="w-4 h-4 mr-2" />
                    Sync Now
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}