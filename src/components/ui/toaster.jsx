import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";

const TOAST_DURATION = 5000; // ms before auto-dismiss

function AutoToast({ id, title, description, action, open, onOpenChange, duration = TOAST_DURATION, ...props }) {
  const dismiss = useRef(onOpenChange);
  dismiss.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => dismiss.current?.(false), duration);
    return () => clearTimeout(t);
  }, [open, duration]);

  return (
    <Toast {...props} data-state={open ? "open" : "closed"}>
      <div className="grid gap-1">
        {title && <ToastTitle>{title}</ToastTitle>}
        {description && <ToastDescription>{description}</ToastDescription>}
      </div>
      {action}
      <ToastClose onClick={() => dismiss.current?.(false)} />
    </Toast>
  );
}

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, ...props }) => (
        <AutoToast key={id} id={id} {...props} />
      ))}
      <ToastViewport />
    </ToastProvider>
  );
} 