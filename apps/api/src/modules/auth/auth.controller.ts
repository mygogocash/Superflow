import type { CookieOptions, Request, Response } from "express";
import { Router } from "express";

import { logger } from "@/common/utils/logger";
import { authenticate, requireActive } from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { supabaseAdmin } from "@/infrastructure/supabase/admin";
import { authService } from "@/modules/auth/auth.service";
import {
  authEmailRequestSchema,
  changePasswordSchema,
  exchangeSessionSchema,
  loginSchema,
  recoverPasswordSchema,
  setActiveEntitySchema,
  setActiveOrganizationSchema,
  updateMyProfileSchema,
} from "@/modules/auth/auth.validation";
import { isExpoClient } from "@/modules/auth/expo-client";
import {
  isLocalDevToken,
  refreshLocalDevSession,
} from "@/modules/auth/local-dev-auth";

const IS_PROD = process.env.NODE_ENV === "production";

function setAuthCookies(
  res: Response,
  session: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  },
) {
  const cookieBase: CookieOptions = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "none" : "lax",
    path: "/",
  };

  res.cookie("nexora_access_token", session.accessToken, {
    ...cookieBase,
    maxAge: session.expiresIn * 1000,
  });

  res.cookie("nexora_refresh_token", session.refreshToken, {
    ...cookieBase,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookies(res: Response) {
  const cookieBase: CookieOptions = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "none" : "lax",
    path: "/",
  };
  res.clearCookie("nexora_access_token", cookieBase);
  res.clearCookie("nexora_refresh_token", cookieBase);
}

function requestIp(req: { ip?: string; socket?: { remoteAddress?: string } }) {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function readRefreshToken(req: Request): string | undefined {
  const cookie = req.cookies?.nexora_refresh_token;
  if (typeof cookie === "string" && cookie.length > 0) return cookie;
  const body = req.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === "string" ? body.refreshToken : undefined;
}

function sendAuthenticatedPayload(
  req: Request,
  res: Response,
  result: Awaited<ReturnType<typeof authService.login>>,
) {
  setAuthCookies(res, result.session);
  const { session, ...payload } = result;
  // Next.js stays cookie-only. Expo is cross-origin / native, so it needs
  // the JWTs in the body and sends them back as Authorization: Bearer.
  if (isExpoClient(req)) {
    res.json({ ...payload, session });
    return;
  }
  res.json(payload);
}

const router = Router();

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    logger.info(`User logged in: ${input.email}`);

    sendAuthenticatedPayload(req, res, result);
  }),
);

router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const input = authEmailRequestSchema.parse(req.body);
    await authService.requestPasswordReset(input, { ip: requestIp(req) });
    res.json({
      success: true,
      message:
        "If this email belongs to an active Manut account, a reset link will be sent shortly.",
    });
  }),
);

router.post(
  "/magic-link",
  asyncHandler(async (req, res) => {
    const input = authEmailRequestSchema.parse(req.body);
    await authService.requestMagicLink(input, { ip: requestIp(req) });
    res.json({
      success: true,
      message:
        "If this email belongs to an active Manut account, a sign-in link will be sent shortly.",
    });
  }),
);

router.post(
  "/recover-password",
  asyncHandler(async (req, res) => {
    const input = recoverPasswordSchema.parse(req.body);
    const result = await authService.recoverPassword(input, {
      ip: requestIp(req),
    });
    sendAuthenticatedPayload(req, res, result);
  }),
);

router.post(
  "/exchange-session",
  asyncHandler(async (req, res) => {
    const input = exchangeSessionSchema.parse(req.body);
    const result = await authService.exchangeSession(input, {
      ip: requestIp(req),
    });
    sendAuthenticatedPayload(req, res, result);
  }),
);

router.post("/logout", authenticate, async (req, res) => {
  logger.info(`User logged out: ${req.user?.email}`);
  clearAuthCookies(res);
  res.json({ success: true });
});

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const refreshToken = readRefreshToken(req);
    if (!refreshToken) {
      res.status(401).json({
        error: { code: "NO_REFRESH_TOKEN", message: "No refresh token" },
      });
      return;
    }

    if (isLocalDevToken(refreshToken)) {
      const local = refreshLocalDevSession(refreshToken);
      if (!local) {
        clearAuthCookies(res);
        res.status(401).json({
          error: { code: "REFRESH_FAILED", message: "Session expired" },
        });
        return;
      }
      const session = {
        accessToken: local.accessToken,
        refreshToken: local.refreshToken,
        expiresIn: local.expiresIn,
      };
      setAuthCookies(res, session);
      if (isExpoClient(req)) {
        res.json({ success: true, session });
        return;
      }
      res.json({ success: true });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      clearAuthCookies(res);
      res.status(401).json({
        error: { code: "REFRESH_FAILED", message: "Session expired" },
      });
      return;
    }

    const session = {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
    };
    setAuthCookies(res, session);

    if (isExpoClient(req)) {
      res.json({ success: true, session });
      return;
    }
    res.json({ success: true });
  }),
);

router.get(
  "/me",
  authenticate,
  requireActive,
  asyncHandler(async (req, res) => {
    const result = await authService.getMe(req.user!.id);
    res.json(result);
  }),
);

router.get(
  "/me/profile",
  authenticate,
  requireActive,
  asyncHandler(async (req, res) => {
    const result = await authService.getMyProfile(req.user!.id);
    res.json({ data: result });
  }),
);

router.patch(
  "/me/profile",
  authenticate,
  requireActive,
  asyncHandler(async (req, res) => {
    const input = updateMyProfileSchema.parse(req.body);
    const result = await authService.updateMyProfile(req.user!.id, input);
    res.json({ data: result });
  }),
);

// Multi-company switcher (PRD Rule 7). Switch the caller's selected
// company. Authenticated + active; the service fails closed unless the
// caller holds an active membership in the target entity. Additive — no
// existing route or field is affected, and permission resolution is
// untouched.
router.put(
  "/active-entity",
  authenticate,
  requireActive,
  asyncHandler(async (req, res) => {
    const input = setActiveEntitySchema.parse(req.body);
    const result = await authService.setActiveEntity(
      req.user!.id,
      input.entityId,
    );
    res.json({ data: result });
  }),
);

router.put(
  "/active-organization",
  authenticate,
  requireActive,
  asyncHandler(async (req, res) => {
    const input = setActiveOrganizationSchema.parse(req.body);
    const result = await authService.setActiveOrganization(
      req.user!.id,
      input.organizationId,
    );
    res.json({ data: result });
  }),
);

router.post(
  "/change-password",
  authenticate,
  asyncHandler(async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.user!.id, {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    clearAuthCookies(res);
    res.json({ success: true });
  }),
);

export default router;
