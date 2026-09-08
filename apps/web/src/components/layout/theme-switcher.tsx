"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * Light / Dark / System theme control. Replaces the old binary toggle, which
 * flipped on `theme` — so a "system" user's first click compared against
 * "dark" and did the wrong thing. This drives `setTheme` with an explicit
 * choice and shows the *resolved* icon (sun/moon), falling back to the monitor
 * glyph while following the OS. next-themes persists the choice; the `mounted`
 * guard avoids a hydration mismatch since the server can't know the theme.
 */
export function ThemeSwitcher() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Before mount, render a stable, theme-agnostic icon so SSR and the first
  // client paint match (no hydration warning, no flash).
  const TriggerIcon = !mounted
    ? Sun
    : theme === "system"
      ? Monitor
      : resolvedTheme === "dark"
        ? Moon
        : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Change theme"
          className={`
            text-muted-foreground relative size-7
            hover:text-foreground
          `}
        >
          <TriggerIcon className="size-4" />
          <span className="sr-only">Change theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={mounted ? (theme ?? "system") : "system"}
          onValueChange={setTheme}
        >
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              className="gap-2 text-sm"
            >
              <Icon className="size-4 opacity-80" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
