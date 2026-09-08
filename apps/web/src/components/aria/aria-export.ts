import type { LocalMessage } from "@/components/aria/aria-utils";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "aria-conversation"
  );
}

function visible(messages: LocalMessage[]): LocalMessage[] {
  return messages.filter((m) => !m.pending && m.content.trim().length > 0);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function exportConversationMarkdown(
  messages: LocalMessage[],
  title: string,
): void {
  const msgs = visible(messages);
  if (msgs.length === 0) return;

  const header = `# ${title}\n\n_Exported ${new Date().toLocaleString()}_\n\n---\n\n`;
  const body = msgs
    .map((m) => {
      const who = m.role === "user" ? "You" : "Manut AI";
      const when = new Date(m.createdAt).toLocaleString();
      return `### ${who}  ·  ${when}\n\n${m.content}\n`;
    })
    .join("\n---\n\n");

  const blob = new Blob([header + body], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(title)}-${timestamp()}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportConversationPDF(
  messages: LocalMessage[],
  title: string,
): void {
  const msgs = visible(messages);
  if (msgs.length === 0) return;

  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) return;

  const rows = msgs
    .map((m) => {
      const who = m.role === "user" ? "You" : "Manut AI";
      const when = new Date(m.createdAt).toLocaleString();
      const content = escapeHtml(m.content).replace(/\n/g, "<br/>");
      const tone = m.role === "user" ? "user" : "assistant";
      return `<section class="msg msg--${tone}">
        <header><span class="who">${who}</span><span class="when">${when}</span></header>
        <div class="body">${content}</div>
      </section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #fafaf7; --surf: #ffffff; --tx: #0b0b0a; --tx2: #3a3a3c;
    --tx3: #8e8e93; --acc: #3738a7; --brd: rgba(11,11,10,.085);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--tx);
    font-family: "DM Sans", system-ui, -apple-system, Segoe UI, sans-serif;
    font-size: 13px; line-height: 1.55; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 28px 48px; }
  h1 { font-family: "DM Serif Display", Georgia, serif; font-weight: 400;
    font-size: 28px; letter-spacing: -0.01em; margin: 0 0 4px; }
  .meta { color: var(--tx3); font-size: 11px; margin-bottom: 24px;
    text-transform: uppercase; letter-spacing: 0.08em; }
  .msg { background: var(--surf); border: 1px solid var(--brd);
    border-radius: 10px; padding: 14px 16px; margin: 0 0 12px; }
  .msg--user { background: rgba(55,56,167,0.04); }
  .msg header { display: flex; justify-content: space-between; gap: 12px;
    margin-bottom: 8px; align-items: baseline; }
  .who { font-weight: 600; font-size: 12px; color: var(--tx); }
  .when { color: var(--tx3); font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.06em; }
  .body { color: var(--tx2); white-space: pre-wrap; word-wrap: break-word; }
  @media print {
    body { background: white; }
    main { padding: 0; max-width: none; }
    .msg { break-inside: avoid; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Exported ${escapeHtml(new Date().toLocaleString())}  ·  ${msgs.length} messages</p>
  ${rows}
</main>
<script>
  window.addEventListener("load", () => {
    setTimeout(() => { window.print(); }, 150);
  });
</script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

export function copyLastReply(messages: LocalMessage[]): string | null {
  const msgs = visible(messages);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      void navigator.clipboard.writeText(msgs[i].content);
      return msgs[i].content;
    }
  }
  return null;
}
