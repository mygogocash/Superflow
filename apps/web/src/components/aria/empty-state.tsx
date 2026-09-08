import { MessageSquarePlus, Sparkles } from "lucide-react";

import { AriaPresetGrid } from "@/components/aria/aria-preset-grid";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EmptyState({
  onNew,
  onPickPreset,
  presetsDisabled,
}: {
  onNew: () => void;
  onPickPreset: (prompt: string) => void;
  presetsDisabled?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-8">
      <div
        className={cn(
          "mb-6 flex size-16 items-center justify-center rounded-2xl",
          "bg-linear-to-br from-violet-500/10 to-indigo-600/10",
        )}
      >
        <Sparkles className="size-7 text-violet-500" />
      </div>
      <h2 className="text-foreground mb-2 text-lg font-semibold">
        Welcome to Manut AI
      </h2>
      <p
        className={`
          text-muted-foreground mb-2 max-w-sm text-center text-[13px]
          leading-relaxed
        `}
      >
        Your AI-powered assistant for Manut. Ask a question below, start a
        blank chat, or use a quick action.
      </p>
      <Button onClick={onNew} variant="secondary" className="mb-2 gap-2">
        <MessageSquarePlus className="size-4" />
        New blank chat
      </Button>
      <AriaPresetGrid onPick={onPickPreset} disabled={presetsDisabled} />
    </div>
  );
}
