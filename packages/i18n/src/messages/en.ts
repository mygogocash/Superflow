// English is the source catalog and the shape contract: `th` is typed against
// `Messages`, so a missing or misspelled key fails type-check rather than
// silently falling back at runtime. Namespaces group by surface; keep keys
// stable (they are referenced by t("namespace.key")).
export const en = {
  common: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    close: "Close",
    loading: "Loading…",
    search: "Search",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
    submit: "Submit",
    saving: "Saving…",
  },
  language: {
    label: "Language",
    english: "English",
    thai: "Thai",
    switchTo: "Switch language",
  },
  auth: {
    signIn: "Sign in",
    signInSubtitle: "Enter your credentials to access the portal",
    signingIn: "Signing in…",
    email: "Email",
    password: "Password",
    emailPlaceholder: "you@manut.xyz",
    passwordPlaceholder: "Enter your password",
    forgotPassword: "Forgot password?",
    emailRequired: "Email is required",
    emailInvalid: "Please enter a valid email address",
    passwordRequired: "Password is required",
    passwordMin: "Password must be at least 6 characters",
    loginFailed: "Login failed",
  },
} as const;

// Widen leaf string literals to `string` while preserving the key structure,
// so every locale must supply the same keys (parity) but with its own values.
type Stringify<T> = {
  [K in keyof T]: T[K] extends string ? string : Stringify<T[K]>;
};

/** The shape every locale catalog must satisfy. */
export type Messages = Stringify<typeof en>;
