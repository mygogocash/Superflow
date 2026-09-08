export interface LocalPreferences {
  emailNotifications: boolean;
  inAppNotifications: boolean;
  language: string;
}

export const DEFAULT_PREFS: LocalPreferences = {
  emailNotifications: true,
  inAppNotifications: true,
  language: "en",
};

export function loadPreferences(): LocalPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem("nexora_preferences");
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULT_PREFS;
}

export function savePreferences(prefs: LocalPreferences) {
  localStorage.setItem("nexora_preferences", JSON.stringify(prefs));
}

export const TABS_LIST = [
  { id: "profile", label: "Profile" },
  { id: "preferences", label: "Preferences" },
  { id: "security", label: "Security" },
  { id: "integrations", label: "Integrations" },
  { id: "aria-brief", label: "Manut AI brief" },
  { id: "system", label: "System" },
];
