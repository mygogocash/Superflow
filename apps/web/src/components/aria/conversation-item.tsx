"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";

import { formatDate } from "@/components/aria/aria-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ManutAiConversation } from "@/services/aria.service";

export function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
}: {
  conversation: ManutAiConversation;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg px-2 py-2 transition-colors",
        isActive
          ? "bg-primary/10"
          : "hover:bg-muted/60 text-foreground/70 hover:text-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          title={conversation.title ?? "Untitled"}
          className={cn(
            `
              focus-visible:ring-ring focus-visible:ring-2
              focus-visible:outline-none
              flex min-h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden
              rounded-md py-0.5 pr-0.5 text-left text-[13px] font-normal
            `,
            isActive && "text-primary",
          )}
        >
          <MessageSquarePlus
            className={cn(
              "size-3.5 shrink-0",
              isActive ? "text-primary opacity-70" : "opacity-50",
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {conversation.title ?? "Untitled"}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete conversation: ${conversation.title ?? "Untitled"}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          className={`
            text-muted-foreground shrink-0
            hover:bg-destructive/10 hover:text-destructive
          `}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <p className={`text-muted-foreground/70 mt-0.5 pl-7 text-[10px]`}>
        {formatDate(conversation.updatedAt)}
      </p>
    </div>
  );
}
