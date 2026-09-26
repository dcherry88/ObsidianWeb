// OIDC login (authorization code + PKCE). Every user who signs in gets the same access.
import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
}

interface Session {
  user: SessionUser;
  exp: number;
}

const COOKIE = "ow_sid";
const rid = () => randomBytes(32).toString("base64url");

export interface AuthEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_SCOPES?: string;
  OIDC_ALLOW_INSECURE?: string;
  PUBLIC_URL?: string;
  SESSION_TTL_HOURS?: string;
}

export interface Auth {
  enabled: boolean;
  userOf(c: Context): SessionUser | undefined;
}

export function setupAuth(app: Hono, env: AuthEnv): Auth {
  if (!env.OIDC_ISSUER) return { enabled: false, userOf: () => undefined };
  if (!env.OIDC_CLIENT_ID || !env.PUBLIC_URL) {
    throw new Error("OIDC_ISSUER is set, so OIDC_CLIENT_ID and PUBLIC_URL (for example https://notes.example.com) are required");
  }

  const publicUrl = env.PUBLIC_URL.replace(/\/$/, "");
  const redirectUri = `${publicUrl}/auth/callback`;
  const secure = publicUrl.startsWith("https://");
  const scope = env.OIDC_SCOPES ?? "openid profile email";
  const ttlMs = Number(env.SESSION_TTL_HOURS ?? 168) * 3600_000;
  const insecure = ["1", "true"].includes(env.OIDC_ALLOW_INSECURE ?? "");

  const sessions = new Map<string, Session>();
  const pending = new Map<string, { verifier: string; next: string; exp: number }>();

  // Discovery is lazy and retried, so the app can start before the identity provider is reachable.
  let cfg: Promise<oidc.Configuration> | undefined;
  const config = () =>
    (cfg ??= oidc
      .discovery(
        new URL(env.OIDC_ISSUER!),
        env.OIDC_CLIENT_ID!,
        env.OIDC_CLIENT_SECRET ? { client_secret: env.OIDC_CLIENT_SECRET } : undefined,
        env.OIDC_CLIENT_SECRET ? undefined : oidc.None(),
        insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((e) => {
        cfg = undefined;
        throw e;
      }));

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
    for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  }, 60_000).unref();

  const userOf = (c: Context): SessionUser | undefined => {
    const sid = getCookie(c, COOKIE);
    const s = sid ? sessions.get(sid) : undefined;
    return s && s.exp > Date.now() ? s.user : undefined;
  };

  const safeNext = (n: string | undefined) => (n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/auth/") ? n : "/");

  app.get("/auth/login", async (c) => {
    try {
      const conf = await config();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      pending.set(state, { verifier, next: safeNext(c.req.query("next")), exp: Date.now() + 10 * 60_000 });
      const url = oidc.buildAuthorizationUrl(conf, {
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      return c.redirect(url.href);
    } catch (e) {
      console.error("[auth] login failed:", e);
      return c.text("Sign-in is unavailable: could not reach the identity provider.", 502);
    }
  });

  app.get("/auth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const p = pending.get(state);
    if (!p) return c.text("Sign-in expired or invalid. Start again at /auth/login.", 400);
    pending.delete(state);
    try {
      const conf = await config();
      const current = new URL(redirectUri);
      current.search = new URL(c.req.url).search;
      const tokens = await oidc.authorizationCodeGrant(conf, current, { pkceCodeVerifier: p.verifier, expectedState: state });
      const claims = tokens.claims();
      if (!claims) throw new Error("no ID token returned");
      const sid = rid();
      sessions.set(sid, {
        user: {
          sub: claims.sub,
          name: (claims.name as string) ?? (claims.preferred_username as string) ?? undefined,
          email: claims.email as string | undefined,
        },
        exp: Date.now() + ttlMs,
      });
      setCookie(c, COOKIE, sid, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: Math.floor(ttlMs / 1000) });
      return c.redirect(p.next);
    } catch (e) {
      console.error("[auth] callback failed:", e);
      return c.text("Sign-in failed. Check the server log.", 401);
    }
  });

  app.get("/auth/logout", (c) => {
    const sid = getCookie(c, COOKIE);
    if (sid) sessions.delete(sid);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.html('<!doctype html><meta charset="utf-8"><title>Signed out</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><div>You are signed out. <a href="/auth/login">Sign in again</a></div>');
  });

  app.get("/auth/me", (c) => {
    const u = userOf(c);
    return u ? c.json(u) : c.json({ error: "unauthorized" }, 401);
  });

  // Gate everything else. API calls get 401 JSON; page loads are redirected to sign in.
  const gate: MiddlewareHandler = async (c, next) => {
    const p = c.req.path;
    if (p === "/healthz" || p.startsWith("/auth/") || userOf(c)) return next();
    if (p.startsWith("/api/") || p === "/config.json" || c.req.method !== "GET") return c.json({ error: "unauthorized", login: "/auth/login" }, 401);
    return c.redirect(`/auth/login?next=${encodeURIComponent(p)}`);
  };
  app.use("*", gate);

  return { enabled: true, userOf };
}
