"use client";
import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

// Cardoso terminal-style toasts: dark card body, phosphor amber left strip,
// type-tinted border + glow (success=green, error=red, warning=phosphor,
// info=cyan). Mono header, cushy padding, soft radial glow that matches the
// rest of the BAT module's aesthetic.
const Toaster = ({
  ...props
}) => {
  const { theme = "system" } = useTheme()

  return (
    (<Sonner
      theme={theme}
      className="toaster group"
      style={{
        // Sonner reads these CSS vars for backgrounds / borders / text per type.
        // Defining them here keeps the per-type styling consistent across the app.
        '--normal-bg':       'hsl(var(--card))',
        '--normal-text':     'hsl(var(--foreground))',
        '--normal-border':   'hsl(var(--border))',

        '--success-bg':      'hsl(145 35% 12%)',
        '--success-text':    'hsl(145 70% 75%)',
        '--success-border':  'hsl(145 55% 45%)',

        '--error-bg':        'hsl(0 35% 12%)',
        '--error-text':      'hsl(0 75% 80%)',
        '--error-border':    'hsl(0 72% 50%)',

        '--warning-bg':      'hsl(33 35% 10%)',
        '--warning-text':    'hsl(33 95% 75%)',
        '--warning-border':  'hsl(33 95% 55%)',

        '--info-bg':         'hsl(200 35% 10%)',
        '--info-text':       'hsl(200 80% 80%)',
        '--info-border':     'hsl(200 80% 55%)',
      }}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: [
            'group toast cardoso-toast',
            'group-[.toaster]:rounded-[2px]',
            'group-[.toaster]:border',
            'group-[.toaster]:border-l-2',
            'group-[.toaster]:px-4 group-[.toaster]:py-3',
            // Use the body sans stack (Inter Tight) at a comfortable reading size,
            // not mono micro-text. Toasts are read in a hurry — clarity > styling.
            'group-[.toaster]:font-sans group-[.toaster]:text-sm',
            'group-[.toaster]:shadow-[0_8px_24px_rgba(0,0,0,0.45),0_0_18px_hsla(33,95%,55%,0.10)]',
            'group-[.toaster]:backdrop-blur-sm',
          ].join(' '),
          title:        'font-sans text-[15px] font-semibold tracking-tight leading-snug',
          description:  'font-sans text-[13px] font-normal leading-snug opacity-90 mt-1',
          actionButton: 'group-[.toast]:bg-accent group-[.toast]:text-accent-foreground group-[.toast]:rounded-[2px] group-[.toast]:font-sans group-[.toast]:text-xs group-[.toast]:font-medium',
          cancelButton: 'group-[.toast]:bg-transparent group-[.toast]:text-muted-foreground group-[.toast]:border group-[.toast]:border-border group-[.toast]:rounded-[2px] group-[.toast]:font-sans group-[.toast]:text-xs group-[.toast]:font-medium',
          closeButton:  'group-[.toast]:bg-transparent group-[.toast]:border-border group-[.toast]:text-muted-foreground hover:group-[.toast]:text-foreground',
        },
      }}
      {...props} />)
  );
}

export { Toaster }
