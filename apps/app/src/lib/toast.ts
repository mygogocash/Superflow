import { create } from "zustand";

export type ToastVariant = "default" | "success" | "error";

type ToastItem = {
  id: string;
  message: string;
  variant: ToastVariant;
};

type ToastState = {
  items: ToastItem[];
  push: (message: string, variant?: ToastVariant) => void;
  dismiss: (id: string) => void;
};

let seq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, variant = "default") => {
    const id = `toast-${Date.now()}-${seq++}`;
    set((s) => {
      const dropped = s.items.slice(0, Math.max(0, s.items.length - 2));
      for (const d of dropped) clearTimer(d.id);
      return { items: [...s.items.slice(-2), { id, message, variant }] };
    });
    const ttl = variant === "error" ? 5200 : 3200;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
      }, ttl),
    );
  },
  dismiss: (id) => {
    clearTimer(id);
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
  },
}));

export function toast(message: string, variant: ToastVariant = "default") {
  useToastStore.getState().push(message, variant);
}
