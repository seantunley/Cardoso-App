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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Database, X, RefreshCcw, Play, Table, Eye, EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import FieldMappingBuilder from "./FieldMappingBuilder";

async function fetchLocalCustomFields() {
  const response = await fetch("/api/custom-fields", {
    method: "GET",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to load custom fields");
  return Array.isArray(result) ? result : [];
}

async function runLocalImport(connectionId) {
  const response = await fetch(`/api/import/${connectionId}`, {
    method: "POST",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Import failed");
  return result;
}

const BUILT_IN_LOCAL_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text", isBuiltIn: true },
  { key: "customer_name", label: "Customer Name", type: "text", isBuiltIn: true },
  { key: "outstanding_balance", label: "Outstanding Balance", type: "text", isBuiltIn: true },
  { key: "last_unpaid_invoice_1", label: "Last Invoice — Number", type: "text", isBuiltIn: true },
  { key: "last_unpaid_invoice_1_amount", label: "Last Invoice — Amount", type: "text", isBuiltIn: true },
  { key: "last_unpaid_invoice_date", label: "Last Invoice — Date", type: "text", isBuiltIn: true },
  { key: "last_receipt_number", label: "Last Receipt — Number", type: "text", isBuiltIn: true },
  { key: "last_receipt_amount", label: "Last Receipt — Amount", type: "text", isBuiltIn: true },
  { key: "last_receipt_date", label: "Last Receipt — Date", type: "text", isBuiltIn: true },
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
    sync_query: "",
    query_index_field: "",
    query_field_mappings: {},
    status: "inactive",
  });

  const [connectionTestStatus, setConnectionTestStatus] = useState(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [queryTestStatus, setQueryTestStatus] = useState(null); // null | 'testing' | 'ok' | 'error'
  const [queryColumns, setQueryColumns] = useState([]);
  const [queryPreview, setQueryPreview] = useState([]);
  const [isImporting, setIsImporting] = useState(false);
  const [customLocalFields, setCustomLocalFields] = useState([]);
  const [showPassword, setShowPassword] = useState(false);

  const allLocalFields = [
    ...BUILT_IN_LOCAL_FIELDS,
    ...customLocalFields.map((f) => ({
      key: f.field_key,
      label: f.label,
      type: f.field_type,
      options: f.options,
      isBuiltIn: false,
    })),
  ];

  const loadCustomLocalFields = async () => {
    try {
      const fields = await fetchLocalCustomFields();
      setCustomLocalFields(fields);
    } catch (err) {
      console.error("Failed to load custom fields:", err);
    }
  };

  useEffect(() => {
    if (open) loadCustomLocalFields();
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
        sync_query: connection.sync_query || "",
        query_index_field: connection.query_index_field || "",
        query_field_mappings: (() => {
          const raw = typeof connection.query_field_mappings === "string"
            ? JSON.parse(connection.query_field_mappings || "{}")
            : connection.query_field_mappings || {};
          return raw;
        })(),
        status: connection.status || "inactive",
      });
      // Reset query test state when editing an existing connection
      setQueryTestStatus(null);
      setQueryColumns([]);
      setQueryPreview([]);
      setConnectionTestStatus(null);
    } else {
      setFormData({
        name: "",
        host: "",
        port: 1433,
        database_name: "",
        username: "",
        password: "",
        sync_query: "",
        query_index_field: "",
        query_field_mappings: {},
        status: "inactive",
      });
      setConnectionTestStatus(null);
      setQueryTestStatus(null);
      setQueryColumns([]);
      setQueryPreview([]);
    }
  }, [connection, open]);

  const handleTestConnection = async () => {
    if (!formData.host || !formData.database_name || !formData.username || !formData.password) {
      toast.error("Please fill in all connection details including password");
      setConnectionTestStatus("error");
      return;
    }

    setTestingConnection(true);
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

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "Test failed");

      setConnectionTestStatus("success");
      toast.success("Connection successful");
    } catch (error) {
      setConnectionTestStatus("error");
      toast.error(`Connection failed: ${error.message}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleTestQuery = async () => {
    if (!formData.sync_query?.trim()) {
      toast.error("Enter a SQL query first");
      return;
    }
    const password = formData.password || connection?.encrypted_password;
    if (!formData.host || !formData.database_name || !formData.username || !password) {
      toast.error("Fill in connection details and test the connection first");
      return;
    }

    setQueryTestStatus("testing");
    setQueryColumns([]);
    setQueryPreview([]);

    try {
      const response = await fetch("/api/test-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          host: formData.host,
          port: formData.port || 1433,
          database_name: formData.database_name,
          username: formData.username,
          password,
          query: formData.sync_query,
        }),
      });

      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) throw new Error(data.error || data.detail || `Server error ${response.status}`);

      setQueryColumns(data.columns || []);
      setQueryPreview(data.preview || []);
      setQueryTestStatus("ok");

      // Auto-set index field if not already set and there's an obvious candidate
      if (!formData.query_index_field && data.columns?.length > 0) {
        const autoIndex = data.columns.find((c) =>
          /^(id|custno|customer_?no|customer_?number|cust_?id|account_?no)$/i.test(c)
        );
        if (autoIndex) {
          setFormData((prev) => ({ ...prev, query_index_field: autoIndex }));
        }
      }

      toast.success(`Query OK — ${data.columns?.length || 0} columns, ${data.preview?.length || 0} preview rows`);
    } catch (error) {
      setQueryTestStatus("error");
      toast.error(`Query failed: ${error.message}`);
    }
  };

  const handleSubmit = async () => {

    if (!formData.sync_query?.trim()) {
      toast.error("Please enter a SQL query");
      return;
    }
    if (!formData.query_index_field?.trim()) {
      toast.error("Please specify the index column (unique row identifier)");
      return;
    }

    const dataToSave = {
      name: formData.name,
      host: formData.host,
      port: formData.port,
      database_name: formData.database_name,
      username: formData.username,
      encrypted_password: formData.password || connection?.encrypted_password || "",
      sync_query: formData.sync_query,
      query_index_field: formData.query_index_field,
      query_field_mappings: JSON.stringify(formData.query_field_mappings || {}),
      status: formData.status,
    };

    onSave(dataToSave, connection?.id);
  };

  const handleImport = async () => {
    if (!connection?.id) return;
    setIsImporting(true);
    try {
      const result = await runLocalImport(connection.id);
      toast.success(result.message || `Sync completed — ${result.imported || 0} records`);
    } catch (e) {
      toast.error("Sync failed: " + (e.message || "Unknown error"));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
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
                Configure your SQL Server connection and sync query
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-4">
          {/* ── Connection details ── */}
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
                placeholder="localhost or IP"
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
                  setFormData({ ...formData, port: e.target.value === "" ? "" : parseInt(e.target.value, 10) })
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
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="••••••••"
                className="pr-10 bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
                required={!connection}
              />
              <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {connection && (
              <p className="text-xs text-gray-400">Leave blank to keep existing password</p>
            )}
          </div>

          {/* ── Test connection ── */}
          <div className="pt-2">
            <Button
              type="button"
              onClick={handleTestConnection}
              disabled={testingConnection}
              variant="outline"
              className={`w-full ${
                connectionTestStatus === "success"
                  ? "border-green-700 text-green-400 hover:bg-green-900/20"
                  : connectionTestStatus === "error"
                    ? "border-red-700 text-red-400 hover:bg-red-900/20"
                    : "border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {testingConnection ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Testing Connection...</>
              ) : connectionTestStatus === "success" ? (
                <><span className="mr-2">✓</span>Connection Successful</>
              ) : connectionTestStatus === "error" ? (
                <><X className="w-4 h-4 mr-2" />Connection Failed — Retry</>
              ) : (
                <><Database className="w-4 h-4 mr-2" />Test Connection</>
              )}
            </Button>
          </div>

          {/* ── SQL Query ── */}
          <div className="space-y-3 pt-4 border-t border-gray-800">
            <div>
              <Label className="text-sm font-medium text-gray-300">Sync Query</Label>
              <p className="text-xs text-gray-500 mt-0.5">
                Write a SELECT query. Only the columns you select will be fetched.
                Alias columns to skip manual mapping (e.g. <code className="text-gray-400">AMTDUE AS outstanding_balance</code>).
              </p>
            </div>

            <Textarea
              value={formData.sync_query}
              onChange={(e) => {
                setFormData({ ...formData, sync_query: e.target.value });
                setQueryTestStatus(null);
                setQueryColumns([]);
                setQueryPreview([]);
              }}
              placeholder={`SELECT\n  CUSTNO,\n  CUSTNAME,\n  AMTDUE AS outstanding_balance,\n  INVNO1 AS last_unpaid_invoice_1,\n  INVAMT1 AS last_unpaid_invoice_1_amount,\n  INVDATE1 AS last_unpaid_invoice_date,\n  RECNO1 AS last_receipt_number,\n  RECAMT1 AS last_receipt_amount,\n  RECDATE1 AS last_receipt_date\nFROM ARCUST\nWHERE ACTIVE = 1`}
              rows={8}
              className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-600 font-mono text-sm resize-y"
            />

            <Button
              type="button"
              onClick={handleTestQuery}
              disabled={queryTestStatus === "testing" || !formData.sync_query?.trim()}
              variant="outline"
              className={`w-full ${
                queryTestStatus === "ok"
                  ? "border-green-700 text-green-400 hover:bg-green-900/20"
                  : queryTestStatus === "error"
                    ? "border-red-700 text-red-400 hover:bg-red-900/20"
                    : "border-blue-700 text-blue-300 hover:bg-blue-900/20"
              }`}
            >
              {queryTestStatus === "testing" ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Running Query...</>
              ) : queryTestStatus === "ok" ? (
                <><span className="mr-2">✓</span>Query OK — {queryColumns.length} columns detected</>
              ) : queryTestStatus === "error" ? (
                <><X className="w-4 h-4 mr-2" />Query Error — Fix and retry</>
              ) : (
                <><Play className="w-4 h-4 mr-2" />Test Query (preview 5 rows)</>
              )}
            </Button>
          </div>

          {/* ── Index field ── */}
          {queryColumns.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-300">
                Index Column <span className="text-red-400">*</span>
              </Label>
              <p className="text-xs text-gray-500">
                The column that uniquely identifies each row (used to match records on re-sync).
              </p>
              <Select
                value={formData.query_index_field}
                onValueChange={(val) => setFormData({ ...formData, query_index_field: val })}
              >
                <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                  <SelectValue placeholder="Select the unique key column" />
                </SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700 text-white">
                  {queryColumns.map((col) => (
                    <SelectItem key={col} value={col}>{col}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Manual index field input if query hasn't been tested yet but editing existing */}
          {queryColumns.length === 0 && formData.query_index_field && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-gray-300">Index Column</Label>
              <Input
                value={formData.query_index_field}
                onChange={(e) => setFormData({ ...formData, query_index_field: e.target.value })}
                placeholder="e.g. CUSTNO"
                className="bg-gray-800 border-gray-700 text-gray-100 placeholder:text-gray-500"
              />
              <p className="text-xs text-gray-400">Run "Test Query" to pick from a dropdown instead.</p>
            </div>
          )}

          {/* ── Preview table ── */}
          {queryPreview.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-gray-800">
              <div className="flex items-center gap-2">
                <Table className="w-4 h-4 text-gray-400" />
                <Label className="text-gray-300">Preview (first {queryPreview.length} rows)</Label>
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-800">
                    <tr>
                      {queryColumns.map((col) => (
                        <th
                          key={col}
                          className="px-3 py-2 text-left text-gray-400 font-medium whitespace-nowrap border-b border-gray-700"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryPreview.map((row, i) => (
                      <tr key={i} className={i % 2 === 0 ? "bg-gray-900" : "bg-gray-850"}>
                        {queryColumns.map((col) => (
                          <td
                            key={col}
                            className="px-3 py-1.5 text-gray-300 whitespace-nowrap max-w-[160px] truncate"
                            title={String(row[col] ?? "")}
                          >
                            {row[col] !== null && row[col] !== undefined ? String(row[col]) : (
                              <span className="text-gray-600 italic">null</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Field Mappings ── */}
          {queryColumns.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-gray-800">
              <div>
                <Label className="text-gray-300">Field Mappings</Label>
                <p className="text-xs text-gray-500 mt-0.5">
                  Map SQL columns to local fields. Columns aliased to a local field name (e.g.{" "}
                  <code className="text-gray-400">outstanding_balance</code>) are auto-mapped on sync —
                  no manual mapping needed for those.
                </p>
              </div>

              <div className="p-4 bg-gray-800 rounded-lg border border-gray-700">
                <FieldMappingBuilder
                  fieldMappings={formData.query_field_mappings || {}}
                  availableFields={queryColumns}
                  localFields={allLocalFields}
                  onMappingsChange={(mappings) =>
                    setFormData({ ...formData, query_field_mappings: mappings })
                  }
                />
              </div>

              {/* Quick auto-map button */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"
                onClick={() => {
                  // Auto-map any column whose name exactly matches a local field key
                  const autoMappings = { ...formData.query_field_mappings };
                  for (const col of queryColumns) {
                    const localField = allLocalFields.find((f) => f.key === col);
                    if (localField && !autoMappings[col]) {
                      autoMappings[col] = {
                        sourceField: col,
                        label: localField.label,
                        type: localField.type,
                        isCustom: !localField.isBuiltIn,
                        mode: "sync",
                      };
                    }
                  }
                  setFormData({ ...formData, query_field_mappings: autoMappings });
                  toast.success("Auto-mapped matching column names");
                }}
              >
                Auto-map matching column names
              </Button>
            </div>
          )}

          {/* ── Status ── */}
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
              type="button"
              onClick={handleSubmit}
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
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Syncing...</>
                ) : (
                  <><RefreshCcw className="w-4 h-4 mr-2" />Sync Now</>
                )}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
