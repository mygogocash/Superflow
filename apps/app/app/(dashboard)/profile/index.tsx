import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { api, ApiError } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { BRAND } from "@/lib/brand";
import { useAuth } from "@/store/auth";

type LineStatus = { login: boolean; messaging: boolean; avatarGenerator: boolean };
type LinkCode = { code: string; expiresInSec: number };

export default function ProfileScreen() {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const refreshUser = useAuth((s) => s.refreshUser);
  const [status, setStatus] = useState<LineStatus | null>(null);
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.get<LineStatus>("/line/status");
      setStatus(s);
    } catch {
      setStatus({ login: false, messaging: false, avatarGenerator: false });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function generateLinkCode() {
    setBusy("link");
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ data: LinkCode }>("/auth/me/line-link-code");
      setLinkCode(res.data);
      setMessage(`Send this in LINE: link ${res.data.code}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create link code");
    } finally {
      setBusy(null);
    }
  }

  async function unlinkLine() {
    setBusy("unlink");
    setError(null);
    setMessage(null);
    try {
      await api.post("/auth/me/line-unlink");
      setLinkCode(null);
      await refreshUser();
      setMessage("LINE unlinked from your Manut account.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not unlink LINE");
    } finally {
      setBusy(null);
    }
  }

  async function linkLineLogin() {
    setBusy("oauth");
    setError(null);
    try {
      const { error: baError } = await authClient.linkSocial({
        provider: "line",
        callbackURL: "/profile",
      });
      if (baError) setError(baError.message || "LINE Login link failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "LINE Login link failed");
    } finally {
      setBusy(null);
    }
  }

  async function generateAvatar(style: "initials" | "geometric" | "soft") {
    setBusy(`avatar-${style}`);
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ data: { avatarUrl: string } }>("/auth/me/avatar/generate", {
        style,
      });
      await refreshUser();
      setMessage(`Avatar updated (${style}).`);
      if (res.data?.avatarUrl) {
        // keep message only — refreshUser picks up avatarUrl
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Avatar generation failed");
    } finally {
      setBusy(null);
    }
  }

  const lineLinked = Boolean(user?.lineLinked);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-6 p-6 pb-16">
      <View className="gap-1">
        <Text className="text-2xl font-semibold text-foreground">Profile</Text>
        <Text className="text-sm text-muted-foreground">
          Connect LINE and generate a Manut-branded avatar.
        </Text>
      </View>

      <View className="flex-row items-center gap-4">
        {user?.avatarUrl ? (
          <Image
            source={{ uri: user.avatarUrl }}
            accessibilityLabel="Your avatar"
            style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: BRAND.paper }}
          />
        ) : (
          <View
            className="items-center justify-center rounded-full bg-primary"
            style={{ width: 72, height: 72 }}
          >
            <Text className="text-xl font-semibold text-primary-foreground">
              {(user?.name ?? "?").slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="min-w-0 flex-1">
          <Text className="text-base font-medium text-foreground" numberOfLines={1}>
            {user?.name ?? "—"}
          </Text>
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {user?.email}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            LINE: {lineLinked ? "Linked" : "Not linked"}
          </Text>
        </View>
      </View>

      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {message}
        </Text>
      ) : null}

      <View className="gap-3">
        <Text className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          LINE Official Account
        </Text>
        <Text className="text-sm text-muted-foreground">
          Generate a 6-digit code, then in LINE chat send: link 123456
        </Text>
        {linkCode ? (
          <View className="rounded-md border border-border bg-card px-4 py-3">
            <Text className="text-3xl font-semibold tracking-widest text-foreground">
              {linkCode.code}
            </Text>
            <Text className="mt-1 text-xs text-muted-foreground">
              Expires in {Math.round(linkCode.expiresInSec / 60)} minutes
            </Text>
          </View>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button
            disabled={busy !== null || status?.messaging === false}
            onPress={generateLinkCode}
          >
            {busy === "link" ? (
              <ActivityIndicator color={BRAND.white} />
            ) : (
              <Text>Get link code</Text>
            )}
          </Button>
          {lineLinked ? (
            <Button variant="outline" disabled={busy !== null} onPress={unlinkLine}>
              {busy === "unlink" ? <ActivityIndicator color={BRAND.ink} /> : <Text>Unlink LINE</Text>}
            </Button>
          ) : null}
        </View>
        {status?.messaging === false ? (
          <Text className="text-xs text-muted-foreground">
            Messaging is not configured on this environment yet.
          </Text>
        ) : null}
      </View>

      {status?.login ? (
        <View className="gap-3">
          <Text className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            LINE Login
          </Text>
          <Text className="text-sm text-muted-foreground">
            Link LINE Login so you can sign in with LINE next time (invite-only — no new accounts).
          </Text>
          <Button variant="outline" disabled={busy !== null} onPress={linkLineLogin}>
            {busy === "oauth" ? <ActivityIndicator color={BRAND.ink} /> : <Text>Link LINE Login</Text>}
          </Button>
        </View>
      ) : null}

      {status?.avatarGenerator ? (
        <View className="gap-3">
          <Text className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Avatar generator
          </Text>
          <Text className="text-sm text-muted-foreground">
            Creates a Manut Brand CI initials avatar and sets it on your profile.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {(["initials", "geometric", "soft"] as const).map((style) => (
              <Button
                key={style}
                variant="outline"
                disabled={busy !== null}
                onPress={() => generateAvatar(style)}
              >
                {busy === `avatar-${style}` ? (
                  <ActivityIndicator color={BRAND.ink} />
                ) : (
                  <Text className="capitalize">{style}</Text>
                )}
              </Button>
            ))}
          </View>
        </View>
      ) : null}

      <Pressable onPress={() => router.back()} accessibilityRole="link">
        <Text className="text-sm font-medium text-primary">← Back</Text>
      </Pressable>
    </ScrollView>
  );
}
