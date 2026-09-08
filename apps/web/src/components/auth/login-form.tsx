"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, LogIn } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";

type LoginFormValues = { email: string; password: string };

export function LoginForm() {
  const { login } = useAuth();
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Built with `t` so validation messages follow the selected language.
  const loginSchema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .min(1, t("auth.emailRequired"))
          .email(t("auth.emailInvalid")),
        password: z
          .string()
          .min(1, t("auth.passwordRequired"))
          .min(6, t("auth.passwordMin")),
      }),
    [t],
  );

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: LoginFormValues) => {
    setError("");
    setLoading(true);

    try {
      await login(data.email, data.password);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t("auth.loginFailed"));
      }

      setLoading(false);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="mt-6 flex flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel
                className={`
                  text-muted-foreground text-[10px] font-semibold
                  tracking-[0.08em] uppercase
                `}
              >
                {t("auth.email")}
              </FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="email"
                  placeholder={t("auth.emailPlaceholder")}
                  autoComplete="email"
                  className={`
                    bg-background-secondary h-10
                    placeholder:text-muted-foreground
                    focus:bg-surface
                  `}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between gap-3">
                <FormLabel
                  className={`
                    text-muted-foreground text-[10px] font-semibold
                    tracking-[0.08em] uppercase
                  `}
                >
                  {t("auth.password")}
                </FormLabel>
                <Link
                  href="/forgot-password"
                  className={`
                    text-primary text-[11px] font-medium underline-offset-4
                    hover:underline
                  `}
                >
                  {t("auth.forgotPassword")}
                </Link>
              </div>
              <FormControl>
                <Input
                  {...field}
                  type="password"
                  placeholder={t("auth.passwordPlaceholder")}
                  autoComplete="current-password"
                  className={`
                    bg-background-secondary h-10
                    placeholder:text-muted-foreground
                    focus:bg-surface
                  `}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          variant="gradient"
          disabled={loading}
          className="mt-2 w-full py-2.5 text-[12px] font-semibold"
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <LogIn className="size-4" />
          )}
          {loading ? t("auth.signingIn") : t("auth.signIn")}
        </Button>

        {/*
         * Magic-link sign-in is gated to the IT role during phased
         * rollout (see MAGIC_LINK_ALLOWED_ROLES in
         * apps/api/src/modules/auth/auth.service.ts). Authenticated
         * non-IT users have no need to discover the route, so the
         * entry button is hidden from the public sign-in page. IT
         * staff navigate to /magic-link directly. The backend rejects
         * non-allowed roles silently regardless.
         */}
      </form>
    </Form>
  );
}
