import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { hasPermission } from "@/lib/permissions";
import { ShieldOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Search,
  Filter,
  FileBarChart,
  TrendingUp,
  Flag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { parseAppDate } from "@/lib/dates";

async function fetchLocalRecords() {
  const response = await fetch("/api/datarecord", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch records");
  }

  return Array.isArray(result) ? result : [];
}

export default function Reports() {
  const [searchQuery, setSearchQuery] = useState("");
  const [flagFilters, setFlagFilters] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState("asc");

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  const {
    data: records = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["reports-records"],
    queryFn: fetchLocalRecords,
    enabled: hasPermission(currentUser, "can_access_reports"),
  });

  if (currentUser && !hasPermission(currentUser, "can_access_reports")) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-muted-foreground">
        <ShieldOff className="w-12 h-12 text-muted-foreground/50" />
        <p className="text-lg font-medium">Access Denied</p>
        <p className="text-sm">You don't have permission to view Reports.</p>
      </div>
    );
  }

  const extractAgeValue = (ageAnalysis) => {
    if (!ageAnalysis) return 0;
    const matches = ageAnalysis.match(/R\s*[\d,]+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) return 0;

    return matches.reduce((sum, match) => {
      const numStr = match.replace(/R\s*/g, "").replace(/,/g, "");
      return sum + parseFloat(numStr);
    }, 0);
  };

  const normalizeAgeDisplay = (str) => {
    if (!str) return str;
    return str
      .replace(/30\s*Days?/gi, "7 Days")
      .replace(/60\s*Days?/gi, "14 Days")
      .replace(/90\+?\s*Days?/gi, "21+ Days");
  };

  const processedRecords = records.map((record) => {
    const rawAge = record.age_analysis || record.data?.age_analysis || "";
    const normalizedAge = normalizeAgeDisplay(rawAge);

    return {
      ...record,
      customerNumber: record.customer_number || record.data?.customer_number || "N/A",
      customerName: record.customer_name || record.data?.customer_name || "Unknown",
      ageAnalysis: normalizedAge,
      ageValue: extractAgeValue(rawAge),
      flagColor: record.flag_color || "none",
    };
  });

  const toggleFlagFilter = (flag) => {
    setFlagFilters((prev) =>
      prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]
    );
  };

  const clearFilters = () => {
    setSearchQuery("");
    setFlagFilters([]);
    setDateFrom("");
    setDateTo("");
  };

  const filteredRecords = processedRecords.filter((record) => {
    const matchesSearch =
      !searchQuery ||
      record.customerNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      record.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      record.ageAnalysis.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFlag =
      flagFilters.length === 0 || flagFilters.includes(record.flagColor);

    const recordDate = parseAppDate(record.created_date);
    const fromDate = dateFrom ? new Date(`${dateFrom}T00:00:00+02:00`) : null;
    const toDate = dateTo ? new Date(`${dateTo}T23:59:59+02:00`) : null;

    const matchesDateFrom = !fromDate || (recordDate && recordDate >= fromDate);
    const matchesDateTo = !toDate || (recordDate && recordDate <= toDate);

    return matchesSearch && matchesFlag && matchesDateFrom && matchesDateTo;
  });

  const sortedRecords = [...filteredRecords].sort((a, b) => {
    if (!sortColumn) return 0;

    let aVal;
    let bVal;

    switch (sortColumn) {
      case "customerNumber":
        aVal = a.customerNumber;
        bVal = b.customerNumber;
        break;
      case "customerName":
        aVal = a.customerName.toLowerCase();
        bVal = b.customerName.toLowerCase();
        break;
      case "ageAnalysis":
        aVal = a.ageAnalysis;
        bVal = b.ageAnalysis;
        break;
      case "ageValue":
        aVal = a.ageValue;
        bVal = b.ageValue;
        break;
      case "flagColor":
        aVal = a.flagColor;
        bVal = b.flagColor;
        break;
      default:
        return 0;
    }

    if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
    if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const renderSortIcon = (column) => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />;
    }

    return sortDirection === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3" />
    );
  };

  const totalAgeValue = sortedRecords.reduce((sum, r) => sum + r.ageValue, 0);
  const avgAgeValue =
    sortedRecords.length > 0 ? Math.round(totalAgeValue / sortedRecords.length) : 0;

  const hasActiveFilters =
    searchQuery || flagFilters.length > 0 || dateFrom || dateTo;

  const canonicalBuckets = ["Current", "7 Days", "14 Days", "21+ Days"];

  const calculateAgeBuckets = () => {
    const bucketTotals = [0, 0, 0, 0];

    filteredRecords.forEach((record) => {
      const ageAnalysis = record.ageAnalysis;
      if (!ageAnalysis) return;

      const matches = [...ageAnalysis.matchAll(/R\s*([\d,]+(?:\.\d+)?)/g)];
      matches.forEach((m, idx) => {
        if (idx < 4) {
          bucketTotals[idx] += parseFloat(m[1].replace(/,/g, ""));
        }
      });
    });

    return canonicalBuckets
      .map((name, idx) => ({
        name,
        value: Math.round(bucketTotals[idx]),
      }))
      .filter((b) => b.value > 0);
  };

  const chartData = calculateAgeBuckets();

  const flagColors = {
    none: { bg: "bg-slate-100", text: "text-slate-700", label: "No Flag" },
    red: { bg: "bg-red-100", text: "text-red-700", label: "Red" },
    green: { bg: "bg-green-100", text: "text-green-700", label: "Green" },
    orange: { bg: "bg-orange-100", text: "text-orange-700", label: "Orange" },
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="mx-auto max-w-7xl space-y-4 p-4 lg:p-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            Age Analysis Reports
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            View and analyze customer age analysis data
          </p>
        </div>

        {error && (
          <Card className="border-rose-700 bg-rose-900/20">
            <CardContent className="p-4">
              <p className="text-sm text-rose-300">
                {error.message || "Failed to load report data"}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <FileBarChart className="h-3.5 w-3.5" />
                Total Customers
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                {sortedRecords.length}
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                {records.length !== sortedRecords.length
                  ? `of ${records.length} total`
                  : "in database"}
              </p>
            </CardContent>
          </Card>

          <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <TrendingUp className="h-3.5 w-3.5" />
                Total Age Value
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                R{totalAgeValue.toLocaleString('en-US')}
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                Sum of all age analysis values
              </p>
            </CardContent>
          </Card>

          <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <TrendingUp className="h-3.5 w-3.5" />
                Average Age Value
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                R{avgAgeValue.toLocaleString('en-US')}
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                Average per customer
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-[var(--text-primary)]">
              <BarChart3 className="h-4 w-4" />
              Age Analysis Distribution
            </CardTitle>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              Total age value across different aging periods
            </p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis
                  dataKey="name"
                  stroke="var(--text-secondary)"
                  tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                />
                <YAxis
                  stroke="var(--text-secondary)"
                  tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                  tickFormatter={(value) => `R${value.toLocaleString('en-US')}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(31, 41, 55, 0.95)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    color: "var(--text-primary)",
                  }}
                  formatter={(value) => [`R${value.toLocaleString('en-US')}`, "Amount"]}
                  labelStyle={{ color: "var(--text-primary)" }}
                  itemStyle={{ color: "var(--text-primary)" }}
                  cursor={{ fill: "rgba(255, 255, 255, 0.1)" }}
                />
                <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                  {chartData.map((entry, index) => {
                    const colors = ["#22c55e", "#eab308", "#f97316", "#ef4444"];
                    return <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base text-[var(--text-primary)]">
                <Filter className="h-4 w-4" />
                Filters
              </CardTitle>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-7 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear All
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
                Filter by Flags
              </label>
              <div className="flex flex-wrap gap-1.5">
                {["none", "red", "green", "orange"].map((flag) => (
                  <Button
                    key={flag}
                    variant={flagFilters.includes(flag) ? "default" : "outline"}
                    size="sm"
                    onClick={() => toggleFlagFilter(flag)}
                    style={
                      !flagFilters.includes(flag)
                        ? { color: "#000000", borderColor: "var(--border-color)" }
                        : {}
                    }
                    className={cn(
                      "flex h-7 items-center gap-1.5 px-2.5 text-xs",
                      flagFilters.includes(flag) &&
                        flag === "red" &&
                        "bg-red-500 text-white hover:bg-red-600",
                      flagFilters.includes(flag) &&
                        flag === "green" &&
                        "bg-green-500 text-white hover:bg-green-600",
                      flagFilters.includes(flag) &&
                        flag === "orange" &&
                        "bg-orange-500 text-white hover:bg-orange-600",
                      flagFilters.includes(flag) &&
                        flag === "none" &&
                        "bg-slate-500 text-white hover:bg-slate-600"
                    )}
                  >
                    {flag === "none" ? (
                      <Flag className="h-3 w-3" />
                    ) : (
                      <div
                        className={cn(
                          "h-2 w-2 rounded-full",
                          flag === "red" && "bg-red-500",
                          flag === "green" && "bg-green-500",
                          flag === "orange" && "bg-orange-500"
                        )}
                      />
                    )}
                    {flagColors[flag].label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search customers..."
                className="h-8 border-[var(--border-color)] bg-[var(--bg-tertiary)] pl-9 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  From Date
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-8 border-[var(--border-color)] bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  To Date
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-8 border-[var(--border-color)] bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)]"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-[var(--text-primary)]">
              Customer Records
            </CardTitle>
          </CardHeader>

          <CardContent>
            {isLoading ? (
              <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
                Loading records...
              </div>
            ) : sortedRecords.length === 0 ? (
              <div className="py-8 text-center">
                <FileBarChart className="mx-auto mb-3 h-10 w-10 text-[var(--text-tertiary)]" />
                <p className="text-sm text-[var(--text-secondary)]">No records found</p>
                {hasActiveFilters && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearFilters}
                    className="mt-3 h-7 border-[var(--border-color)] text-xs text-[var(--text-primary)]"
                  >
                    Clear Filters
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--border-color)]">
                      <th
                        className="cursor-pointer px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => handleSort("customerNumber")}
                      >
                        <div className="flex items-center">
                          Customer #
                          {renderSortIcon("customerNumber")}
                        </div>
                      </th>
                      <th
                        className="cursor-pointer px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => handleSort("customerName")}
                      >
                        <div className="flex items-center">
                          Name
                          {renderSortIcon("customerName")}
                        </div>
                      </th>
                      <th
                        className="cursor-pointer px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => handleSort("ageAnalysis")}
                      >
                        <div className="flex items-center">
                          Age Analysis
                          {renderSortIcon("ageAnalysis")}
                        </div>
                      </th>
                      <th
                        className="cursor-pointer px-3 py-2 text-right text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => handleSort("ageValue")}
                      >
                        <div className="flex items-center justify-end">
                          Age Value
                          {renderSortIcon("ageValue")}
                        </div>
                      </th>
                      <th
                        className="cursor-pointer px-3 py-2 text-center text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => handleSort("flagColor")}
                      >
                        <div className="flex items-center justify-center">
                          Flag
                          {renderSortIcon("flagColor")}
                        </div>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {sortedRecords.map((record) => (
                      <tr
                        key={record.id}
                        className="border-b border-[var(--border-color)] transition-colors hover:bg-[var(--bg-tertiary)]"
                      >
                        <td className="px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
                          {record.customerNumber}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--text-primary)]">
                          {record.customerName}
                        </td>
                        <td className="max-w-xs truncate px-3 py-2 text-xs text-[var(--text-secondary)]">
                          {record.ageAnalysis || "N/A"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs font-semibold text-[var(--text-primary)]">
                          {record.ageValue > 0 ? record.ageValue.toLocaleString('en-US') : "-"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {record.flagColor && record.flagColor !== "none" ? (
                            <Badge
                              className={cn(
                                "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]",
                                flagColors[record.flagColor].bg,
                                flagColors[record.flagColor].text
                              )}
                            >
                              <div
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full",
                                  record.flagColor === "red" && "bg-red-500",
                                  record.flagColor === "green" && "bg-green-500",
                                  record.flagColor === "orange" && "bg-orange-500"
                                )}
                              />
                              {flagColors[record.flagColor].label}
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-[var(--text-tertiary)]">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}