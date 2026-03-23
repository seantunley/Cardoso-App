import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { FileText, Database, Flag } from "lucide-react";
import StatCard from "../components/dashboard/StatCard";

export default function Dashboard() {
  const { data: connections = [] } = useQuery({
    queryKey: ["connections"],
    queryFn: () => base44.entities.DatabaseConnection.list("-created_date"),
  });

  const { data: records = [] } = useQuery({
    queryKey: ["records"],
    queryFn: () => base44.entities.DataRecord.list("-created_date", 1000),
  });

  const totalRecords = records.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
            Dashboard
          </h1>
          <p className="text-slate-500 mt-1">
            Overview of your data sync system
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <StatCard
            title="Total Records"
            value={totalRecords.toLocaleString()}
            icon={FileText}
            color="blue"
          />
          <StatCard
            title="Connections"
            value={connections.length}
            icon={Database}
            color="slate"
            subtitle={`${connections.filter(c => c.status === "active").length} active`}
          />
          <StatCard
            title="Total Flags"
            value={records.filter(r => r.flag_color && r.flag_color !== "none").length}
            icon={Flag}
            color="amber"
          />
        </div>
      </div>
    </div>
  );
}