"use client";

import { isLocale, LOCALE_LABELS, SUPPORTED_LOCALES } from "@nexora/i18n";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALE_STORAGE_KEY } from "@/providers/i18n-provider";

/**
 * Language picker. Persists to localStorage and switches i18next immediately.
 * When a user is authenticated, the choice is also written to their profile
 * (User.locale) so it follows them across devices — wired where the switcher
 * is mounted inside the dashboard shell.
 */
export function LanguageSwitcher({
  onChange,
  className,
}: {
  onChange?: (locale: string) => void;
  className?: string;
}) {
  const { i18n, t } = useTranslation();

  const handleChange = (value: string) => {
    if (!isLocale(value)) return;
    void i18n.changeLanguage(value);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, value);
    } catch {
      // Non-fatal: the language still changes for this session.
    }
    onChange?.(value);
  };

  return (
    <Select value={i18n.language} onValueChange={handleChange}>
      <SelectTrigger className={className} aria-label={t("language.switchTo")}>
        <Languages className="size-4 opacity-70" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((locale) => (
          <SelectItem key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
