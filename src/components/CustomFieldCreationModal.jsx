import { useState } from "react";
import { api } from "@/api/apiClient";
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
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export default function CustomFieldCreationModal({
  open,
  onClose,
  onFieldCreated,
}) {
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const queryClient = useQueryClient();

  const createFieldMutation = useMutation({
    mutationFn: async (data) => {
      const fieldKey = `custom_${data.name.toLowerCase().replace(/\s+/g, "_")}`;
      return api.entities.CustomFieldConfig.create({
        field_key: fieldKey,
        label: data.name,
        field_type: data.type,
        is_active: true,
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["customFieldConfigs"] });
      toast.success("Custom field created successfully");
      if (onFieldCreated) {
        onFieldCreated(result);
      }
      setFieldName("");
      setFieldType("text");
      onClose();
    },
    onError: (error) => {
      toast.error("Failed to create custom field");
      console.error(error);
    },
  });

  const handleCreate = () => {
    if (!fieldName.trim()) {
      toast.error("Field name is required");
      return;
    }

    createFieldMutation.mutate({
      name: fieldName,
      type: fieldType,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md bg-gray-900 border-gray-700">
        <DialogHeader>
          <DialogTitle className="text-white">Create Custom Field</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-gray-300">
              Field Name
            </Label>
            <Input
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              placeholder="e.g., Department, Region, Account Type"
              className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-500"
              disabled={createFieldMutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-gray-300">
              Data Type
            </Label>
            <Select
              value={fieldType}
              onValueChange={setFieldType}
              disabled={createFieldMutation.isPending}
            >
              <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-white">
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="select">Dropdown/Select</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            className="border-gray-700 text-gray-300 hover:bg-gray-800"
            disabled={createFieldMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={createFieldMutation.isPending || !fieldName.trim()}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {createFieldMutation.isPending && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            Create Field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}