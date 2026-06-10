// Promise-based replacement for window.confirm, rendered through the themed
// AlertDialog so destructive confirmations match the app (keyboard/focus
// handling from Radix, dark theme, consistent button styling) instead of the
// browser-native dialog, which ignores the theme and can be suppressed by the
// browser after repeated prompts.
//
// Usage:
//   const confirm = useConfirm();
//   const onDelete = async () => {
//     if (!(await confirm({ title: "Delete user?", description: "This cannot be undone.", confirmLabel: "Delete", destructive: true }))) return;
//     ...do it
//   };
import { createContext, useCallback, useContext, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [pending, setPending] = useState(null); // { title, description, confirmLabel, cancelLabel, destructive }
  const resolveRef = useRef(null);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      // If a confirm is somehow already open, settle it as cancelled so the
      // earlier caller never hangs on an orphaned promise.
      if (resolveRef.current) resolveRef.current(false);
      resolveRef.current = resolve;
      setPending({
        title: opts?.title || "Are you sure?",
        description: opts?.description || "",
        confirmLabel: opts?.confirmLabel || "Confirm",
        cancelLabel: opts?.cancelLabel || "Cancel",
        destructive: !!opts?.destructive,
      });
    });
  }, []);

  const settle = (result) => {
    setPending(null);
    if (resolveRef.current) {
      resolveRef.current(result);
      resolveRef.current = null;
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) settle(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            {pending?.description ? (
              <AlertDialogDescription className="whitespace-pre-line">{pending.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{pending?.cancelLabel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              className={pending?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            >
              {pending?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
