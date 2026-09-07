import type { LucideIcon } from "lucide-react-native";
import {
  CalendarDays,
  Home,
  Menu,
  MessageSquare,
  Sparkles,
  Wallet,
} from "lucide-react-native";
import type { DockDestinationId } from "@/lib/dock-nav";

export const DOCK_ICONS: Record<DockDestinationId, LucideIcon> = {
  home: Home,
  aria: Sparkles,
  messages: MessageSquare,
  more: Menu,
  leave: CalendarDays,
  expenses: Wallet,
};
