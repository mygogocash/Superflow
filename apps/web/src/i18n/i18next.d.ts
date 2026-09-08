import type { Messages } from "@nexora/i18n";

// Make t() key-safe: t("auth.signIn") type-checks, t("auth.typo") errors.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Messages };
  }
}
