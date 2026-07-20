// SidebarHelpSettings — the two footer flyouts (Help + Settings) that open to
// the RIGHT of the sidebar, modelled on the n8n help/settings UX.
//
//   • Help    — Quickstart · User manual · Full manual (PDF, new tab) ·
//               Search & shortcuts (⌘K) · About + version. Shown to everyone.
//   • Settings — quick-jump to any settings tab. Deep-links into the EXISTING
//               SettingsPanel via onOpenSettingsTab(tabId); the tab list comes
//               from buildSettingsTabGroups() — the SAME registry the panel and
//               the command palette use, so the three can never disagree.
//
// Collapsed rail: only the Help flyout is shown as an icon. The Settings flyout
// is expanded-only — the collapsed rail already has the Settings gear one click
// away, and a multi-group flyout off a 40px icon is awkward. (See the account
// footer in Layout.jsx for that gear; this component sits directly above it.)

import { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  LifeBuoy, Settings, BookOpen, FileText, Rocket, Keyboard, Info, ChevronRight,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

// Expanded trigger row: full-width, leading icon + label + trailing chevron.
// Colors reuse the sidebar tokens exactly as the nav items do.
const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-[hsla(var(--sidebar-foreground),0.65)] transition-colors hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]";

// Collapsed trigger: centered icon button, same affordance as SidebarButton.
const ICON_BTN =
  "flex h-10 w-10 items-center justify-center rounded-md text-[hsla(var(--sidebar-foreground),0.55)] transition-colors hover:text-[var(--phosphor)] hover:bg-[hsl(var(--sidebar-accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]";

// Menu items that are Links reuse the item styling via asChild; icons inherit
// the item's [&>svg] sizing.
const ITEM_LINK = "cursor-pointer";

/**
 * @param {{
 *   collapsed?: boolean,
 *   canSeeSettings?: boolean,
 *   settingsGroups?: Array<{ name: string, tabs: Array<{ id: string, label: string }> }>,
 *   onOpenSettingsTab?: (tabId: string) => void,
 *   onOpenCommandPalette?: () => void,
 *   appVersion?: string,
 * }} props
 */
export default function SidebarHelpSettings({
  collapsed = false,
  canSeeSettings = false,
  settingsGroups = [],
  onOpenSettingsTab,
  onOpenCommandPalette,
  appVersion,
}) {
  const helpTrigger = collapsed ? (
    <button type="button" className={ICON_BTN} title="Help" aria-label="Help">
      <LifeBuoy className="h-4 w-4" />
    </button>
  ) : (
    <button type="button" className={ROW}>
      <LifeBuoy className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Help</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
    </button>
  );

  return (
    <div className={collapsed ? "flex flex-col items-center gap-0.5" : "space-y-0.5"}>
      {/* ── HELP (everyone) ── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{helpTrigger}</DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
          <DropdownMenuItem asChild className={ITEM_LINK}>
            <Link to="/Help?article=finding-your-way-around">
              <Rocket className="h-4 w-4" /> Quickstart
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={ITEM_LINK}>
            <Link to="/Help">
              <BookOpen className="h-4 w-4" /> User manual
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className={ITEM_LINK}>
            <a href="/manual" target="_blank" rel="noopener noreferrer">
              <FileText className="h-4 w-4" /> Full manual · PDF
            </a>
          </DropdownMenuItem>
          {onOpenCommandPalette && (
            <DropdownMenuItem
              className={ITEM_LINK}
              onSelect={() => {
                // Let the menu close first, then open the palette, so the two
                // focus-trapping overlays don't fight over focus.
                setTimeout(() => onOpenCommandPalette(), 0);
              }}
            >
              <Keyboard className="h-4 w-4" /> Search &amp; shortcuts
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className={ITEM_LINK}>
            <Link to="/Help?article=welcome">
              <Info className="h-4 w-4" /> About{appVersion ? ` · v${appVersion}` : ""}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── SETTINGS (expanded only; permission-gated) ── */}
      {!collapsed && canSeeSettings && settingsGroups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={ROW}>
              <Settings className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Settings</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="end"
            sideOffset={8}
            className="max-h-[72vh] w-56 overflow-y-auto"
          >
            {settingsGroups.map((group, i) => (
              <Fragment key={group.name}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                  {group.name}
                </DropdownMenuLabel>
                {group.tabs.map((tab) => (
                  <DropdownMenuItem
                    key={tab.id}
                    className={ITEM_LINK}
                    onSelect={() => onOpenSettingsTab?.(tab.id)}
                  >
                    {tab.label}
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
