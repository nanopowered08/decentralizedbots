// Discord OAuth2 login for the dashboard. Only Discord user ids listed in OWNER_IDS get a session.
export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string; // e.g. https://your-app.replit.app (no trailing slash)
  sessionSecret: string;
  apiBase: string; // overridable so tests can point at a fake Discord
  oauthBase: string;
}

export const AUTH_ENV = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "PUBLIC_URL", "SESSION_SECRET"];

export function authConfigFromEnv(): AuthConfig | null {
  const e = (k: string) => Deno.env.get(k);
  if (AUTH_ENV.some((k) => !e(k))) return null;
  return {
    clientId: e("DISCORD_CLIENT_ID")!,
    clientSecret: e("DISCORD_CLIENT_SECRET")!,
    publicUrl: e("PUBLIC_URL")!.replace(/\/+$/, ""),
    sessionSecret: e("SESSION_SECRET")!,
    apiBase: e("DISCORD_API_BASE") ?? "https://discord.com/api",
    oauthBase: e("DISCORD_OAUTH_BASE") ?? "https://discord.com",
  };
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface Session {
  id: string;
  name: string;
}

const SESSION_SECONDS = 12 * 3600;

async function makeSession(cfg: AuthConfig, s: Session): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...s, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  return `${payload}.${await hmac(cfg.sessionSecret, payload)}`;
}

export async function getSession(req: Request, cfg: AuthConfig, owners: Set<string>): Promise<Session | null> {
  const raw = cookies(req)["session"];
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEqual(sig, await hmac(cfg.sessionSecret, payload))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof p.id !== "string" || p.exp < Date.now() / 1000 || !owners.has(p.id)) return null; // re-checked every request
    return { id: p.id, name: String(p.name ?? p.id) };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5">${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } },
  );

export async function handleAuth(req: Request, url: URL, cfg: AuthConfig, owners: Set<string>): Promise<Response | null> {
  const secure = cfg.publicUrl.startsWith("https://") ? "; Secure" : "";
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  const redirectUri = `${cfg.publicUrl}/auth/callback`;

  if (url.pathname === "/login") {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state,
    });
    return new Response(null, {
      status: 302,
      headers: { location: `${cfg.oauthBase}/oauth2/authorize?${q}`, "set-cookie": cookie("oauth_state", state, 600) },
    });
  }

  if (url.pathname === "/auth/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const clear = cookie("oauth_state", "", 0);
    if (!state || !code || !safeEqual(state, cookies(req)["oauth_state"] ?? "")) {
      return page("Login failed", `<h1>Login failed</h1><p>Missing or mismatched state. <a href="/login">Try again</a>.</p>`, 400, { "set-cookie": clear });
    }
    try {
      const tr = await fetch(`${cfg.apiBase}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!tr.ok) throw new Error(`token exchange failed (HTTP ${tr.status})`);
      const { access_token } = await tr.json();
      const ur = await fetch(`${cfg.apiBase}/users/@me`, {
        headers: { authorization: `Bearer ${access_token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!ur.ok) throw new Error(`user lookup failed (HTTP ${ur.status})`);
      const me = await ur.json();
      if (!owners.has(String(me.id))) {
        return page("Not allowed", `<h1>Not allowed</h1><p>${esc(String(me.username ?? me.id))} is not an owner of this bot.</p>`, 403, { "set-cookie": clear });
      }
      const session = await makeSession(cfg, { id: String(me.id), name: String(me.global_name ?? me.username ?? me.id) });
      const h = new Headers({ location: "/dashboard" });
      h.append("set-cookie", clear);
      h.append("set-cookie", cookie("session", session, SESSION_SECONDS));
      return new Response(null, { status: 302, headers: h });
    } catch (e) {
      return page("Login failed", `<h1>Login failed</h1><p>${esc((e as Error).message)}. <a href="/login">Try again</a>.</p>`, 502, { "set-cookie": clear });
    }
  }

  if (url.pathname === "/logout") {
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie("session", "", 0) } });
  }
  return null;
}
