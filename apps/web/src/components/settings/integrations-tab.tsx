"use client";

import {
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api-client";
import {
  disconnectGoogle,
  getIntegrationsStatus,
  type GoogleConnectionStatus,
  type IntegrationsStatus,
  type IntegrationStatus,
  startGoogleOauth,
} from "@/services/integrations.service";

function humanizeExpires(expiresAt?: string): string {
  if (!expiresAt) return "";
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "expired";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${hours} h`;
  const days = Math.round(hours / 24);
  return `expires in ${days} d`;
}

function parseScopes(scope?: string): {
  gmail: boolean;
  gmailSend: boolean;
  drive: boolean;
  calendar: boolean;
} {
  const s = scope ?? "";
  const gmailSend =
    s.includes("gmail.compose") ||
    s.includes("gmail.send") ||
    s.includes("gmail.modify") ||
    s.includes("mail.google.com");
  return {
    gmail: s.includes("gmail."),
    gmailSend,
    drive: s.includes("drive."),
    calendar: s.includes("calendar."),
  };
}

function AnthropicStatus({ s }: { s: IntegrationStatus }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <div
          className={`
            bg-muted flex size-10 shrink-0 items-center justify-center
            rounded-md
          `}
        >
          <Sparkles className="size-5" />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <span className="text-sm font-medium">Anthropic Claude API</span>
          <p className="text-muted-foreground text-xs">
            Powers Manut AI + integrations. Configured via Cloud Run env (admin).
          </p>
          <div className="mt-1">
            {s.configured ? (
              <Badge
                variant="outline"
                className={`border-success/40 bg-success/10 text-success`}
              >
                <CheckCircle2 className="mr-1 size-3" />
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                <XCircle className="mr-1 size-3" />
                Not Configured
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function GoogleCard({
  google,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
}: {
  google: GoogleConnectionStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
}) {
  const scopes = parseScopes(google.scope);
  const sendBlocked = google.connected && google.canSendMail === false;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start gap-4">
          <div
            className={`
              bg-muted flex size-10 shrink-0 items-center justify-center
              rounded-md
            `}
          >
            <Mail className="size-5" />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-sm font-medium">Google Workspace</span>
            {google.connected ? (
              <p className="text-muted-foreground text-xs">
                Connected as{" "}
                <span className="text-foreground font-medium">
                  {google.accountEmail ?? "(unknown)"}
                </span>
                {google.expiresAt ? (
                  <> · {humanizeExpires(google.expiresAt)}</>
                ) : null}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Connect your Google Workspace account to enable Gmail and Drive
                in Manut.
              </p>
            )}
          </div>
        </div>

        {sendBlocked ? (
          <p className="text-warning text-xs">
            Gmail is read-only on this connection. Disconnect and reconnect to
            enable sending from the portal.
          </p>
        ) : null}

        {google.connected && (
          <div className="flex flex-wrap items-center gap-1">
            {scopes.gmail && (
              <Badge variant="outline" className="text-xs">
                <Mail className="mr-1 size-3" />
                Gmail{scopes.gmailSend ? " · send" : " · read only"}
              </Badge>
            )}
            {scopes.drive && (
              <Badge variant="outline" className="text-xs">
                <FileText className="mr-1 size-3" />
                Drive
              </Badge>
            )}
            {!scopes.gmail && !scopes.drive && (
              <Badge
                variant="outline"
                className="text-muted-foreground text-xs"
              >
                No scopes detected
              </Badge>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {google.connected ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={disconnecting}
            >
              {disconnecting && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={connecting}>
              {connecting && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              Connect Google
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function IntegrationsTab() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getIntegrationsStatus();
      setStatus(res.data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Failed to load integration status",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const { url } = await startGoogleOauth();
      // window.location.assign is hard to assert directly in jsdom without a stub.
      // The settings page handles ?connected=1 / ?error= on return.
      window.location.assign(url);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Failed to start Google sign-in";
      toast.error(message);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      setDisconnecting(true);
      await disconnectGoogle();
      toast.success("Google account disconnected");
      setConfirmOpen(false);
      await fetchStatus();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Failed to disconnect Google account";
      toast.error(message);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Card className="animate-pulse">
          <CardContent className="h-24" />
        </Card>
        <Card className="animate-pulse">
          <CardContent className="h-20" />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent
          className={`
            text-destructive flex items-center justify-between gap-2 py-4
            text-sm
          `}
        >
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void fetchStatus()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!status) return null;

  return (
    <div className="space-y-4">
      <GoogleCard
        google={status.google}
        onConnect={handleConnect}
        onDisconnect={() => setConfirmOpen(true)}
        connecting={connecting}
        disconnecting={disconnecting}
      />
      <AnthropicStatus s={status.anthropic} />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Gmail and Drive will stop working until you reconnect. Your stored
              refresh token will be revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDisconnect();
              }}
              disabled={disconnecting}
            >
              Confirm disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
