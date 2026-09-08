"use client";

import { useTranslation } from "react-i18next";

import { LoginForm } from "@/components/auth/login-form";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";

export default function SignInPage() {
  const { t } = useTranslation();

  return (
    <div
      className={`
        bg-background flex min-h-screen w-full items-center justify-center
      `}
    >
      <div
        className={`
          border-border bg-surface w-[440px] max-w-[95vw] rounded-[14px] border
          p-9 shadow-lg
        `}
      >
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 shrink-0"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary-light)))",
                clipPath:
                  "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              }}
            />
            <div>
              <div className="text-[15px] font-bold tracking-wide">Manut</div>
              <div
                className={`
                  text-muted-foreground text-[9px] font-normal tracking-[0.12em]
                  uppercase
                `}
              >
                Manut
              </div>
            </div>
          </div>
          <LanguageSwitcher className="h-8 w-auto gap-1.5 text-xs" />
        </div>
        <h1 className="font-sans text-xl">{t("auth.signIn")}</h1>
        <p className="text-muted-foreground mt-1 text-[11px]">
          {t("auth.signInSubtitle")}
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
