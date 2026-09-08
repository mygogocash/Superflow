"use client";

import {
  FileText,
  Film,
  ImageIcon,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  Paperclip,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import React, {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { AriaDocumentParsePanel } from "@/components/aria/aria-document-parse-panel";
import { AriaPresetChips } from "@/components/aria/aria-preset-chips";
import { AriaToolbar } from "@/components/aria/aria-toolbar";
import type {
  LocalMessage,
  LocalMessageAttachment,
} from "@/components/aria/aria-utils";
import { ConversationItem } from "@/components/aria/conversation-item";
import { DateSeparator, isNewDay } from "@/components/aria/date-separator";
import { EmptyState } from "@/components/aria/empty-state";
import { MessageBubble } from "@/components/aria/message-bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";
import type { AriaConversation, AriaMessage } from "@/services/aria.service";
import {
  deleteConversation,
  getConversation,
  listConversations,
  streamAriaChat,
  uploadAriaAttachment,
} from "@/services/aria.service";

export default function AriaPage() {
  const { hasPermission } = useAuth();
  const canUse = hasPermission("aria:use");
  const canParse = hasPermission("aria:parse");

  const [workspace, setWorkspace] = useState<"chat" | "documents">("chat");

  const [conversations, setConversations] = useState<AriaConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState("");
  // Files attached to the next message (upload-first — each is uploaded on
  // select and referenced by id when the message sends).
  const [attachments, setAttachments] = useState<LocalMessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  // Persist the sidebar open/close pref so the chat history affordance
  // sticks across sessions. HR feedback: "Can not see history chat" —
  // largely because some users had collapsed the sidebar without an
  // obvious reopen affordance, and there was no explicit "History"
  // label inside the panel.
  // Start from `true` so SSR and the first client render agree (reading
  // localStorage in the initialiser made the hydrated HTML differ from
  // the server's → "Prop did not match" warning on the <aside> width).
  // Read the persisted pref after mount; the panel then settles to it.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  useEffect(() => {
    /*
     * Below `md` the history is an overlay, so honouring a stored "open" pref
     * would cover the chat the moment the page loads. The pref is a desktop
     * affordance; on a phone the Menu button in the header is the way in.
     */
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen(false);
      return;
    }
    const stored = window.localStorage.getItem("aria.sidebarOpen");
    if (stored !== null) setSidebarOpen(stored === "1");
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("aria.sidebarOpen", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);
  const [search, setSearch] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch(() => toast.error("Failed to load conversations"))
      .finally(() => setLoading(false));
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setMessages([]);
      // Don't let a file staged (but not sent) in another thread ride into
      // this one, and drop any half-typed text too.
      setInput("");
      setAttachments([]);
      try {
        const convo = await getConversation(id);
        setMessages(
          convo.messages.map((m: AriaMessage) => ({
            ...m,
            pending: false,
          })),
        );
        scrollToBottom();
      } catch {
        setActiveId(null);
        toast.error("Failed to load conversation");
      }
    },
    [scrollToBottom],
  );

  const handleNewConversation = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setInput("");
    setAttachments([]);
    inputRef.current?.focus();
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
      } catch {
        toast.error("Failed to delete conversation");
      }
    },
    [activeId],
  );

  // Single stream-event handler shared by the plain-send, edit, and
  // retry flows. Caller controls how the message list is primed
  // *before* the stream starts; this just merges deltas + tool-use
  // events into the pending row and finalises on `done`/`error`.
  const consumeStream = useCallback(
    async (
      text: string,
      streamOpts: {
        tempUserId: string | null;
        pendingAssistantId: string;
        editMessageId?: string;
        retryAssistantMessageId?: string;
        attachmentIds?: string[];
        wasNewChat: boolean;
      },
    ) => {
      const { tempUserId, pendingAssistantId, wasNewChat } = streamOpts;
      try {
        await streamAriaChat(
          text,
          activeId ?? undefined,
          (ev) => {
            if (ev.t === "meta") {
              if (wasNewChat) {
                setActiveId(ev.conversationId);
                void listConversations().then(setConversations);
              }
              return;
            }
            if (ev.t === "delta") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingAssistantId
                    ? { ...m, content: m.content + ev.text }
                    : m,
                ),
              );
              scrollToBottom();
              return;
            }
            if (ev.t === "tool_use") {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== pendingAssistantId) return m;
                  const existing = m.toolUses ?? [];
                  const idx = existing.findIndex((t) => t.id === ev.id);
                  const next: typeof existing =
                    idx >= 0
                      ? existing.map((t, i) =>
                          i === idx
                            ? {
                                ...t,
                                status: ev.status,
                                summary: ev.summary || t.summary,
                              }
                            : t,
                        )
                      : [
                          ...existing,
                          {
                            id: ev.id,
                            name: ev.name,
                            summary: ev.summary,
                            status: ev.status,
                          },
                        ];
                  return { ...m, toolUses: next };
                }),
              );
              scrollToBottom();
              return;
            }
            if (ev.t === "done") {
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === ev.message.conversationId
                    ? { ...c, updatedAt: new Date().toISOString() }
                    : c,
                ),
              );
              setMessages((prev) => {
                const pending = prev.find((m) => m.id === pendingAssistantId);
                return prev
                  .filter((m) => m.id !== pendingAssistantId)
                  .map((m) =>
                    tempUserId && m.id === tempUserId
                      ? { ...m, id: `sent-${Date.now()}` }
                      : m,
                  )
                  .concat({
                    id: ev.message.id,
                    role: "assistant",
                    content: ev.message.content,
                    createdAt: ev.message.createdAt,
                    toolUses: pending?.toolUses,
                  });
              });
              scrollToBottom();
              return;
            }
            if (ev.t === "error") {
              toast.error(ev.message);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingAssistantId
                    ? {
                        ...m,
                        pending: false,
                        content:
                          m.content.trim() ||
                          "Sorry, something went wrong. Please try again.",
                      }
                    : m,
                ),
              );
            }
          },
          {
            editMessageId: streamOpts.editMessageId,
            retryAssistantMessageId: streamOpts.retryAssistantMessageId,
            attachmentIds: streamOpts.attachmentIds,
          },
        );
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingAssistantId
              ? {
                  ...m,
                  pending: false,
                  content: m.content.trim()
                    ? m.content
                    : "Sorry, something went wrong. Please try again.",
                }
              : m,
          ),
        );
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [activeId, scrollToBottom],
  );

  const sendUserMessage = useCallback(
    async (text: string, attachments: LocalMessageAttachment[] = []) => {
      const trimmed = text.trim();
      // Allow a send with only attachments (no typed text).
      if ((!trimmed && attachments.length === 0) || sending || !canUse) return;

      const tempId = `temp-${Date.now()}`;
      const userMsg: LocalMessage = {
        id: tempId,
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      const pendingId = `pending-${Date.now()}`;
      const pendingMsg: LocalMessage = {
        id: pendingId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        pending: true,
      };

      const wasNewChat = !activeId;

      setMessages((prev) => [...prev, userMsg, pendingMsg]);
      setSending(true);
      scrollToBottom();

      await consumeStream(trimmed, {
        tempUserId: tempId,
        pendingAssistantId: pendingId,
        attachmentIds: attachments.map((a) => a.id),
        wasNewChat,
      });
    },
    [sending, canUse, activeId, scrollToBottom, consumeStream],
  );

  const handleEdit = useCallback(
    async (messageId: string, newContent: string) => {
      const trimmed = newContent.trim();
      if (!trimmed || sending || !canUse || !activeId) return;

      const pendingId = `pending-${Date.now()}`;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx < 0) return prev;
        // Truncate from the edited message inclusive, then push the
        // edited user content + a pending assistant placeholder.
        return [
          ...prev.slice(0, idx),
          {
            ...prev[idx],
            content: trimmed,
            createdAt: new Date().toISOString(),
          },
          {
            id: pendingId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            pending: true,
          },
        ];
      });
      setSending(true);
      scrollToBottom();
      await consumeStream(trimmed, {
        tempUserId: null,
        pendingAssistantId: pendingId,
        editMessageId: messageId,
        wasNewChat: false,
      });
    },
    [sending, canUse, activeId, scrollToBottom, consumeStream],
  );

  const handleRetry = useCallback(
    async (assistantMessageId: string) => {
      if (sending || !canUse || !activeId) return;

      const pendingId = `pending-${Date.now()}`;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMessageId);
        if (idx < 0) return prev;
        return [
          ...prev.slice(0, idx),
          {
            id: pendingId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            pending: true,
          },
        ];
      });
      setSending(true);
      scrollToBottom();
      await consumeStream("", {
        tempUserId: null,
        pendingAssistantId: pendingId,
        retryAssistantMessageId: assistantMessageId,
        wasNewChat: false,
      });
    },
    [sending, canUse, activeId, scrollToBottom, consumeStream],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (
      (!text && attachments.length === 0) ||
      sending ||
      uploading ||
      !canUse
    ) {
      return;
    }
    const toSend = attachments;
    setInput("");
    setAttachments([]);
    await sendUserMessage(text, toSend);
  }, [input, attachments, sending, uploading, canUse, sendUserMessage]);

  const handleFilesSelected = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    setUploading(true);
    try {
      for (const file of picked) {
        try {
          const att = await uploadAriaAttachment(file);
          setAttachments((prev) => [...prev, att]);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : `Couldn't attach ${file.name}`,
          );
        }
      }
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const filtered = useMemo(() => {
    if (!search) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) =>
      (c.title ?? "").toLowerCase().includes(q),
    );
  }, [conversations, search]);

  const showEmptyHero =
    workspace === "chat" && !activeId && messages.length === 0;

  const conversationTitle = useMemo(() => {
    const active = conversations.find((c) => c.id === activeId);
    if (active?.title) return active.title;
    const firstUser = messages.find(
      (m) => m.role === "user" && m.content.trim().length > 0,
    );
    if (firstUser) return firstUser.content.slice(0, 60);
    return "Manut AI conversation";
  }, [conversations, activeId, messages]);

  const handleEndSession = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    toast.success("Session ended");
  }, []);

  const handleToggleHistory = useCallback(() => {
    setSidebarOpen((v) => !v);
  }, []);

  const adjustHeight = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, []);

  return (
    /*
      `relative` anchors the mobile history overlay below.

      Height: svh, not vh — mobile browser chrome collapsing changes vh and
      leaves the composer under the fold. The extra 4rem below `md` is the
      mobile dock, which did not exist when this was written; without it the
      composer sits underneath the bar.
    */
    <div
      className={`
        bg-background relative flex h-[calc(100svh-8rem)] overflow-hidden
        rounded-xl border
        md:h-[calc(100svh-4rem)]
      `}
    >
      {/*
        Below `md` the history is an OVERLAY, not a column. As an inline
        column a 288px (w-72) sidebar left roughly 100px of chat on a 390px
        phone, which wrapped the composer placeholder one character per line.
        From `md` up it is the inline column it has always been.
      */}
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close chat history"
          onClick={() => setSidebarOpen(false)}
          className={`
            absolute inset-0 z-10 cursor-default bg-black/30
            md:hidden
          `}
        />
      ) : null}

      <aside
        className={cn(
          `
            border-border bg-muted/30 absolute inset-y-0 left-0 z-20 flex
            min-h-0 flex-col border-r transition-all duration-200
            md:relative md:z-auto
          `,
          sidebarOpen
            ? "w-72 min-w-0 max-w-[85vw]"
            : "w-0 overflow-hidden border-r-0",
        )}
      >
        <div
          className={`border-border flex items-center gap-2 border-b px-3 py-3`}
        >
          <Button
            variant="ghost"
            onClick={handleNewConversation}
            disabled={!canUse}
            className="flex-1 justify-start gap-2 text-[13px]"
          >
            <MessageSquarePlus className="size-4" />
            New chat
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setSidebarOpen(false)}
            aria-label="Hide chat history"
            title="Hide chat history"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>

        <div className="border-border border-b px-3 py-2">
          <div className="relative">
            <Search
              className={`
                text-muted-foreground pointer-events-none absolute top-1/2
                left-2.5 size-3.5 -translate-y-1/2
              `}
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="h-8 pl-8 text-[12px]"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>

        <div
          className={`
            text-muted-foreground border-border flex items-center
            justify-between border-b px-3 py-1.5 text-[9.5px] font-bold
            tracking-widest uppercase
          `}
        >
          <span>History</span>
          {!loading && conversations.length > 0 ? (
            <span className="tabular-nums">{conversations.length}</span>
          ) : null}
        </div>
        {/* `min-h-0` is mandatory: the parent <aside> is a flex
            column, so without it the ScrollArea Root falls back to
            `min-height: auto` (= its content height), grows past the
            aside bounds, and the Viewport never overflows — the user
            sees the conversation list locked with no scrollbar
            engaging. With `min-h-0` the Root can shrink and the
            inner Viewport's overflow-y-auto kicks in. */}
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="flex min-w-0 flex-col gap-0.5 p-2">
            {loading ? (
              <div className="flex justify-center py-8">
                <Spinner className="text-muted-foreground size-5" />
              </div>
            ) : filtered.length === 0 ? (
              <p
                className={`
                  text-muted-foreground px-3 py-8 text-center text-[12px]
                `}
              >
                {search ? "No results found" : "No conversations yet"}
              </p>
            ) : (
              filtered.map((c) => (
                <ConversationItem
                  key={c.id}
                  conversation={c}
                  isActive={c.id === activeId}
                  onSelect={() => loadConversation(c.id)}
                  onDelete={() => handleDelete(c.id)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={`border-border flex items-center gap-3 border-b px-4 py-3`}
        >
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show chat history"
              title="Show chat history"
            >
              <Menu className="size-4" />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg",
                "bg-linear-to-br from-intelligence-500/10 to-intelligence-700/10",
              )}
            >
              <Sparkles className="size-3.5 text-intelligence-500" />
            </div>
            <div className="min-w-0">
              <h1 className="text-foreground text-sm font-semibold">Manut AI</h1>
              <p className="text-muted-foreground text-[10px]">
                {workspace === "documents"
                  ? "Receipt & invoice extraction"
                  : `AI assistant · ${
                      activeId
                        ? `${messages.filter((m) => !m.pending).length} messages`
                        : "Ready"
                    }`}
              </p>
            </div>
          </div>
          {canParse ? (
            <div
              className={`
                border-border bg-muted/40 ml-auto flex shrink-0 rounded-lg
                border p-0.5
              `}
            >
              <Button
                type="button"
                variant={workspace === "chat" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-md px-2.5 text-xs"
                onClick={() => setWorkspace("chat")}
              >
                Chat
              </Button>
              <Button
                type="button"
                variant={workspace === "documents" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-md px-2.5 text-xs"
                onClick={() => setWorkspace("documents")}
              >
                Parse
              </Button>
            </div>
          ) : null}
        </div>

        {workspace === "documents" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AriaDocumentParsePanel />
          </div>
        ) : showEmptyHero ? (
          <EmptyState
            onNew={handleNewConversation}
            onPickPreset={(prompt) => {
              setInput("");
              void sendUserMessage(prompt);
            }}
            presetsDisabled={!canUse || sending}
          />
        ) : (
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto scroll-smooth"
          >
            <div className="flex w-full flex-col gap-4 px-4 py-6">
              {messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : undefined;
                const showSeparator = isNewDay(prev?.createdAt, m.createdAt);
                return (
                  <Fragment key={m.id}>
                    {showSeparator ? <DateSeparator iso={m.createdAt} /> : null}
                    <MessageBubble
                      message={m}
                      onEdit={handleEdit}
                      onRetry={handleRetry}
                      onAction={(prompt) => void sendUserMessage(prompt)}
                      disabled={sending}
                    />
                    {m.role === "user" && m.attachments?.length ? (
                      <div className="flex flex-wrap justify-end gap-2 pr-1">
                        {m.attachments.map((a) => (
                          <span
                            key={a.id}
                            className={`
                              bg-muted/60 text-muted-foreground inline-flex
                              items-center gap-1.5 rounded-md border px-2 py-1
                              text-xs
                            `}
                          >
                            {a.kind === "image" ? (
                              <ImageIcon className="size-3.5 shrink-0" />
                            ) : (
                              <FileText className="size-3.5 shrink-0" />
                            )}
                            <span className="max-w-[180px] truncate">
                              {a.name}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}

        <div
          className={cn(
            "border-border shrink-0 border-t px-4 py-3",
            workspace === "documents" && "hidden",
          )}
        >
          <div className="mx-auto w-full max-w-3xl">
            {!showEmptyHero && (
              <AriaPresetChips
                onPick={(prompt) => {
                  void sendUserMessage(prompt);
                }}
                disabled={sending || !canUse}
                className="mb-2"
              />
            )}
            {attachments.length > 0 || uploading ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    className={`
                      bg-muted text-foreground inline-flex items-center gap-1.5
                      rounded-md border px-2 py-1 text-xs
                    `}
                  >
                    {a.kind === "image" ? (
                      <ImageIcon className="size-3.5 shrink-0" />
                    ) : a.kind === "video" ? (
                      <Film className="size-3.5 shrink-0" />
                    ) : (
                      <FileText className="size-3.5 shrink-0" />
                    )}
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className={`
                        text-muted-foreground
                        hover:text-foreground
                      `}
                      aria-label={`Remove ${a.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {uploading ? (
                  <span
                    className={`
                      text-muted-foreground inline-flex items-center gap-1.5
                      px-1 py-1 text-xs
                    `}
                  >
                    <Spinner className="size-3.5" /> Uploading…
                  </span>
                ) : null}
              </div>
            ) : null}
            <input
              ref={attachInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,text/csv,text/markdown,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,.docx,.xlsx,.pptx,video/mp4,video/quicktime,video/webm,audio/mp4,audio/mpeg,.mp4,.mov,.webm,.m4a,.mp3"
              className="hidden"
              onChange={(e) => {
                void handleFilesSelected(e.target.files);
                e.target.value = "";
              }}
            />
            <div
              className={cn(
                `
                  bg-muted/40 border-border flex items-end gap-2 rounded-xl
                  border px-3 py-2
                `,
                `
                  focus-within:ring-ring/20 focus-within:border-ring/50
                  focus-within:ring-2
                  transition-all
                `,
              )}
            >
              <Button
                size="icon"
                variant="ghost"
                type="button"
                disabled={sending || uploading || !canUse}
                onClick={() => attachInputRef.current?.click()}
                className="size-8 shrink-0 rounded-lg"
                aria-label="Attach a file"
                title="Attach image, PDF, or text file"
              >
                <Paperclip className="size-3.5" />
              </Button>
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  adjustHeight();
                }}
                onKeyDown={handleKeyDown}
                placeholder="Ask Manut AI anything..."
                rows={1}
                disabled={sending || !canUse}
                className={cn(
                  `
                    flex-1 resize-none border-0 bg-transparent py-1.5
                    text-[13px] leading-relaxed shadow-none
                    focus-visible:ring-0
                  `,
                )}
              />
              <Button
                size="icon"
                disabled={
                  (!input.trim() && attachments.length === 0) ||
                  sending ||
                  uploading ||
                  !canUse
                }
                onClick={() => {
                  void handleSend();
                }}
                className="size-8 shrink-0 rounded-lg"
              >
                {sending ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Send className="size-3.5" />
                )}
              </Button>
            </div>
            <div className="mt-2">
              <AriaToolbar
                messages={messages}
                activeId={activeId}
                conversationTitle={conversationTitle}
                onNewChat={handleNewConversation}
                onEndSession={handleEndSession}
                onToggleHistory={handleToggleHistory}
                disabled={sending || !canUse}
              />
            </div>
            <p
              className={`
                text-muted-foreground/50 mt-1.5 text-center text-[10px]
              `}
            >
              Manut AI can make mistakes. Verify important information.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
