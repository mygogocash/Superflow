import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { AuthFrame, AuthLink } from "@/components/auth-frame";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { api, ApiError } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { BRAND } from "@/lib/brand";
import { getAppUrl, usesBetterAuth } from "@/lib/env";

export default function ResetPasswordScreen() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (usesBetterAuth()) {
        const { error: baError } = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: `${getAppUrl()}/reset`,
        });
        if (baError) {
          throw new Error(baError.message || baError.statusText || "Could not start reset");
        }
        setMessage("If an account exists, a reset email is on its way.");
      } else {
        const res = await api.post<{ message?: string }>("/auth/forgot-password", { email: email.trim() });
        setMessage(res.message ?? "If an account exists, a reset email is on its way.");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Could not start reset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Forgot password" subtitle="We’ll email a reset link if that address has an account.">
      <Field label="Email">
        <Input
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@company.com"
          accessibilityLabel="Email"
          value={email}
          onChangeText={setEmail}
        />
      </Field>
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {message ? <Text className="text-sm text-green-800">{message}</Text> : null}
      <Button disabled={busy} onPress={onSubmit}>
        {busy ? <ActivityIndicator color={BRAND.white} /> : <Text>Send reset link</Text>}
      </Button>
      <AuthLink href="/(auth)/login">Back to sign-in</AuthLink>
    </AuthFrame>
  );
}
