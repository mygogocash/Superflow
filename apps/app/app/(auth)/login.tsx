import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AuthFrame, AuthLink } from "@/components/auth-frame";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { ApiError, api } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { BRAND } from "@/lib/brand";
import { useAuth } from "@/store/auth";

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Email or password is incorrect. Check both and try again.";
    if (error.status === 403) return error.message || "You don't have access to this portal.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Sign-in failed. Try again.";
}

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lineLogin, setLineLogin] = useState(false);
  const [lineBusy, setLineBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.get<{ login?: boolean }>("/line/status");
        if (!cancelled) setLineLogin(Boolean(status.login));
      } catch {
        if (!cancelled) setLineLogin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, remember);
      router.replace("/dashboard");
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onLineLogin() {
    setLineBusy(true);
    setError(null);
    try {
      const { error: baError } = await authClient.signIn.social({
        provider: "line",
        callbackURL: "/dashboard",
      });
      if (baError) {
        setError(baError.message || "LINE sign-in failed. Link LINE from Profile after email sign-in.");
      }
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setLineBusy(false);
    }
  }

  return (
    <AuthFrame title="Sign in" subtitle="Enter your work email and password to open the portal.">
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
      <Field label="Password">
        <View className="relative">
          <Input
            autoComplete="password"
            placeholder="Password"
            accessibilityLabel="Password"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={setPassword}
            className="pr-16"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
            onPress={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1.5 h-8 items-center justify-center px-2"
          >
            <Text className="text-sm font-medium text-primary">{showPassword ? "Hide" : "Show"}</Text>
          </Pressable>
        </View>
      </Field>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: remember }}
        onPress={() => setRemember((v) => !v)}
        className="flex-row items-center gap-2 py-1"
      >
        <View
          className={remember ? "items-center justify-center border border-primary bg-primary" : "border border-input bg-card"}
          style={{ width: 16, height: 16, borderRadius: 3 }}
        >
          {remember ? <Text className="text-[10px] leading-3 text-primary-foreground">✓</Text> : null}
        </View>
        <Text className="text-sm text-foreground">Remember me on this device</Text>
      </Pressable>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <Button disabled={busy} onPress={onSubmit} className="mt-1">
        {busy ? <ActivityIndicator color={BRAND.white} /> : <Text>Sign in</Text>}
      </Button>
      {lineLogin ? (
        <Button
          disabled={lineBusy || busy}
          onPress={onLineLogin}
          variant="outline"
          className="mt-1"
          accessibilityLabel="Continue with LINE"
        >
          {lineBusy ? <ActivityIndicator color={BRAND.ink} /> : <Text>Continue with LINE</Text>}
        </Button>
      ) : null}
      <View className="mt-1 flex-row flex-wrap gap-x-4 gap-y-2">
        <AuthLink href="/(auth)/reset">Forgot password?</AuthLink>
        <AuthLink href="/(auth)/magic-link">Use a magic link</AuthLink>
      </View>
    </AuthFrame>
  );
}
