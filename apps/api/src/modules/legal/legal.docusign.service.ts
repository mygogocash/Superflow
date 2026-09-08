import { createHmac, createPrivateKey, createSign } from "node:crypto";

import {
  BadRequestException,
  HttpException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface EnvelopeRecipient {
  signerName: string;
  signerEmail: string;
  // 1-based. DocuSign signs in ascending order; same number = parallel.
  signingOrder: number;
}

interface CreateEnvelopeArgs {
  documentTitle: string;
  documentBase64: string;
  documentMime: string; // e.g. "application/pdf"
  documentFileName: string;
  recipients: EnvelopeRecipient[];
  emailSubject: string;
  emailBlurb?: string;
}

interface CreateEnvelopeResult {
  envelopeId: string;
  status: string;
}

interface EnvelopeStatus {
  envelopeId: string;
  status: string;
  completedDateTime?: string;
  declinedDateTime?: string;
  voidedDateTime?: string;
}

const SCOPES = "signature impersonation";

class DocusignService {
  private cached: CachedToken | null = null;

  /**
   * Returns true if every required env var is set. The integration is
   * optional — if any var is missing the rest of the legal module
   * silently falls back to the in-house signing path.
   */
  isConfigured(): boolean {
    return Boolean(
      process.env.DOCUSIGN_INTEGRATION_KEY &&
      process.env.DOCUSIGN_USER_ID &&
      process.env.DOCUSIGN_ACCOUNT_ID &&
      process.env.DOCUSIGN_RSA_PRIVATE_KEY &&
      process.env.DOCUSIGN_AUTH_BASE_URL &&
      process.env.DOCUSIGN_API_BASE_URL,
    );
  }

  /**
   * URL the admin opens once to grant consent for the impersonation
   * scope. After this is approved, the JWT-grant exchange below works
   * indefinitely without further user interaction.
   */
  buildConsentUrl(): string {
    this.assertConfigured();
    const params = new URLSearchParams({
      response_type: "code",
      scope: SCOPES,
      client_id: process.env.DOCUSIGN_INTEGRATION_KEY!,
      redirect_uri: process.env.DOCUSIGN_REDIRECT_URI ?? "",
    });
    return `${process.env.DOCUSIGN_AUTH_BASE_URL}/oauth/auth?${params.toString()}`;
  }

  /**
   * Get a cached or freshly-minted access token. JWT-grant flow.
   * Tokens are cached in-memory until 60s before expiry.
   */
  async getAccessToken(): Promise<string> {
    this.assertConfigured();
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.accessToken;
    }

    const jwt = this.signJwt();
    const url = `${process.env.DOCUSIGN_AUTH_BASE_URL}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !json.access_token) {
      // The most common 400 here is `consent_required` — the admin
      // hasn't clicked the consent URL yet. Surface a clear error.
      const errCode = json.error ?? "unknown_error";
      const errDesc = json.error_description ?? `HTTP ${res.status}`;
      logger.error("docusign jwt grant failed", { errCode, errDesc });
      if (errCode === "consent_required") {
        throw new BadRequestException(
          "DocuSign admin consent has not been granted yet. Open the consent URL from the admin DocuSign settings page.",
        );
      }
      throw new HttpException(
        500,
        "DOCUSIGN_ERROR",
        `DocuSign auth failed: ${errCode} (${errDesc})`,
      );
    }

    this.cached = {
      accessToken: json.access_token,
      expiresAt: now + (json.expires_in ?? 3600) * 1000,
    };
    return this.cached.accessToken;
  }

  /**
   * Lightweight ping — calls /oauth/userinfo with a JWT-issued token.
   * Used by the admin status page to confirm the integration is wired
   * correctly without sending a real envelope.
   */
  async getStatus(): Promise<{
    configured: boolean;
    consentGranted: boolean;
    accountId: string | null;
    apiBase: string | null;
  }> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        consentGranted: false,
        accountId: null,
        apiBase: null,
      };
    }
    try {
      await this.getAccessToken();
      return {
        configured: true,
        consentGranted: true,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID ?? null,
        apiBase: process.env.DOCUSIGN_API_BASE_URL ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("docusign status check failed", { message });
      return {
        configured: true,
        consentGranted: false,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID ?? null,
        apiBase: process.env.DOCUSIGN_API_BASE_URL ?? null,
      };
    }
  }

  /**
   * Create + send a single-signer envelope. Returns the DocuSign
   * envelope id; callers store this on the LegalSignature row so the
   * Connect webhook can correlate status updates back.
   */
  async createEnvelope(
    args: CreateEnvelopeArgs,
  ): Promise<CreateEnvelopeResult> {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const url = `${process.env.DOCUSIGN_API_BASE_URL}/v2.1/accounts/${process.env.DOCUSIGN_ACCOUNT_ID}/envelopes`;

    const body = {
      emailSubject: args.emailSubject,
      emailBlurb: args.emailBlurb,
      status: "sent",
      documents: [
        {
          documentBase64: args.documentBase64,
          name: args.documentTitle,
          fileExtension: args.documentFileName.split(".").pop() ?? "pdf",
          documentId: "1",
        },
      ],
      recipients: {
        signers: args.recipients.map((r, idx) => ({
          email: r.signerEmail,
          name: r.signerName,
          recipientId: String(idx + 1),
          routingOrder: String(r.signingOrder),
          tabs: {
            signHereTabs: [
              {
                anchorString: "Signature:",
                anchorXOffset: "1",
                anchorYOffset: "0",
                anchorUnits: "inches",
                anchorIgnoreIfNotPresent: "true",
                anchorMatchWholeWord: "true",
              },
            ],
          },
        })),
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as {
      envelopeId?: string;
      status?: string;
      message?: string;
      errorCode?: string;
    };

    if (!res.ok || !json.envelopeId) {
      const errCode = json.errorCode ?? `HTTP_${res.status}`;
      const errMsg = json.message ?? "Unknown error";
      logger.error("docusign create envelope failed", { errCode, errMsg });
      throw new HttpException(
        500,
        "DOCUSIGN_ERROR",
        `DocuSign envelope create failed: ${errCode} ${errMsg}`,
      );
    }

    return { envelopeId: json.envelopeId, status: json.status ?? "sent" };
  }

  async getEnvelope(envelopeId: string): Promise<EnvelopeStatus> {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const url = `${process.env.DOCUSIGN_API_BASE_URL}/v2.1/accounts/${process.env.DOCUSIGN_ACCOUNT_ID}/envelopes/${encodeURIComponent(envelopeId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new HttpException(
        500,
        "DOCUSIGN_ERROR",
        `DocuSign get envelope failed: HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as EnvelopeStatus;
    return json;
  }

  /**
   * Pull the combined signed PDF for a completed envelope. Caller is
   * expected to upload the bytes to Supabase storage so we don't depend
   * on DocuSign retention.
   */
  async downloadCombinedDocument(envelopeId: string): Promise<Buffer> {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const url = `${process.env.DOCUSIGN_API_BASE_URL}/v2.1/accounts/${process.env.DOCUSIGN_ACCOUNT_ID}/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new HttpException(
        500,
        "DOCUSIGN_ERROR",
        `DocuSign download document failed: HTTP ${res.status}`,
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * DocuSign Connect signs each webhook payload with HMAC-SHA256 of the
   * raw body using the account's HMAC secret. This verifies the
   * signature header matches; constant-time compare to dodge timing
   * attacks. Throws on mismatch.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
  ): void {
    const secret = process.env.DOCUSIGN_HMAC_SECRET;
    if (!secret) {
      throw new HttpException(
        500,
        "DOCUSIGN_ERROR",
        "DOCUSIGN_HMAC_SECRET is not configured",
      );
    }
    if (!signatureHeader) {
      throw new BadRequestException("Missing x-docusign-signature-1 header");
    }
    const expected = createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("base64");
    // Constant-time compare. DocuSign sends the signature plain; if you
    // ever rotate to multiple secrets accept any successful match.
    if (
      expected.length !== signatureHeader.length ||
      !timingSafeEqualString(expected, signatureHeader)
    ) {
      throw new BadRequestException("Webhook signature mismatch");
    }
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        "DocuSign integration is not configured on this environment",
      );
    }
  }

  /**
   * Build + sign the JWT used in the JWT-Bearer grant exchange. Spec:
   * https://developers.docusign.com/platform/auth/jwt/jwt-get-token/
   */
  private signJwt(): string {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: process.env.DOCUSIGN_INTEGRATION_KEY,
      sub: process.env.DOCUSIGN_USER_ID,
      // The aud must match the auth host without scheme. Docusign rejects
      // tokens that include the "https://" prefix here.
      aud: (process.env.DOCUSIGN_AUTH_BASE_URL ?? "").replace(
        /^https?:\/\//,
        "",
      ),
      iat: now,
      exp: now + 60 * 60, // 1 hour — DocuSign caps at 1h regardless.
      scope: SCOPES,
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const privateKeyPem = (process.env.DOCUSIGN_RSA_PRIVATE_KEY ?? "").replace(
      /\\n/g,
      "\n",
    );
    const key = createPrivateKey(privateKeyPem);
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(key);
    const signatureB64 = base64UrlEncodeBytes(signature);
    return `${signingInput}.${signatureB64}`;
  }
}

function base64UrlEncode(input: string): string {
  return base64UrlEncodeBytes(Buffer.from(input, "utf8"));
}

function base64UrlEncodeBytes(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const docusignService = new DocusignService();
