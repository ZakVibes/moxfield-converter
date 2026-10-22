// MoxGate - the ONE Durable Object that talks to Moxfield.
//
// Why it exists: Moxfield allows at most one request per second, for everyone
// together. Every Moxfield call (sign-in refresh, card search, deck create,
// deck fill) goes through this single object, one at a time, at least 1.1 s
// apart. It also holds the sign-in cookies and tokens, so no other code ever
// sees them, and it keeps the abuse limits and the "already converted" memory.
//
// Nothing secret is ever logged or returned: only status codes and paths.

import { DurableObject } from "cloudflare:workers";
import { sleep, sha256Hex } from "./util.js";

const MOX_VERSION = "2026.10.21.2"; // sent as x-moxfield-version
const MOX_BASE = "https://api2.moxfield.com";

const MIN_GAP_MS = 1100; // minimum time between the STARTS of two Moxfield calls
const PAUSE_MS = 60_000; // stop calling Moxfield for this long after a 403/429
const FETCH_TIMEOUT_MS = 20_000;
const TOKEN_MARGIN_MS = 60_000; // refresh the access token 1 minute before it ends

const HOUR_MS = 3_600_000;
const MAX_REAL_PER_IP_HOUR = 10;
const MAX_DRY_PER_IP_HOUR = 60;
const MAX_REAL_PER_DAY = 300;
const DUPLICATE_MS = 10 * 60_000;
const JOB_EXPIRY_MS = 5 * 60_000;

export class MoxGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.chain = Promise.resolve(); // every Moxfield call waits its turn on this
    this.lastStart = Date.now(); // after a restart, assume a call just happened
    this.pausedUntil = 0;
    this.userId = "";
    this.token = null; // { value, userId, expiresAt } - memory only, never stored
    this.jobs = new Map(); // conversions currently using Moxfield (for "n ahead")
    ctx.blockConcurrencyWhile(async () => {
      this.pausedUntil = (await ctx.storage.get("pausedUntil")) || 0;
      this.userId = (await ctx.storage.get("userId")) || "";
    });
  }

  // ---------------------------------------------------------------- public API

  // One Moxfield API call, signed in. req = { method, path, body? }.
  // Returns { ok, status, data } or { error: "blocked"|"auth"|"network"|"config" }.
  async mox(req) {
    if (!this.env.MOX_USER_AGENT) return { error: "config" };
    if (!req || typeof req.path !== "string" || !req.path.startsWith("/")) return { error: "config" };
    return this.enqueue(async () => {
      try {
        return await this.doMox(req);
      } catch (err) {
        console.error("gate error", err && err.name);
        return { error: "network" };
      }
    });
  }

  // Weekly cron: one refresh so the 30-day cookies never run out.
  async keepAlive() {
    if (!this.env.MOX_USER_AGENT) return { ok: false, error: "config" };
    const result = await this.enqueue(async () => {
      try {
        return await this.refresh();
      } catch (err) {
        console.error("keepalive error", err && err.name);
        return { error: "network" };
      }
    });
    await this.cleanup();
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }

  // A conversion announces itself before using Moxfield, so later ones can be
  // told how many are ahead of them.
  beginJob() {
    const now = Date.now();
    for (const [id, started] of this.jobs) {
      if (now - started > JOB_EXPIRY_MS) this.jobs.delete(id); // forgotten ones
    }
    const ahead = this.jobs.size;
    const id = crypto.randomUUID();
    this.jobs.set(id, now);
    return { id, ahead };
  }

  endJob(id) {
    this.jobs.delete(id);
  }

  // Abuse limits. kind = "real" or "dry". Only counts the request if commit is true.
  async checkLimit(ipHash, kind, commit) {
    const now = Date.now();
    const storage = this.ctx.storage;
    const real = kind === "real";
    const key = `rl:${real ? "real" : "dry"}:${ipHash}`;
    const times = ((await storage.get(key)) || []).filter((t) => now - t < HOUR_MS);

    if (times.length >= (real ? MAX_REAL_PER_IP_HOUR : MAX_DRY_PER_IP_HOUR)) {
      return {
        ok: false,
        message: real
          ? `You've reached the limit of ${MAX_REAL_PER_IP_HOUR} conversions per hour. Please try again later.`
          : "Too many test requests from your connection. Please try again later.",
      };
    }
    let dayKey = null;
    let dayCount = 0;
    if (real) {
      dayKey = `day:${new Date(now).toISOString().slice(0, 10)}`;
      dayCount = (await storage.get(dayKey)) || 0;
      if (dayCount >= MAX_REAL_PER_DAY) {
        return { ok: false, message: "The converter has reached its limit for today. Please try again tomorrow." };
      }
    }
    if (commit) {
      times.push(now);
      await storage.put(key, times);
      if (real) await storage.put(dayKey, dayCount + 1);
    }
    return { ok: true };
  }

  // "Same link converted in the last 10 minutes" memory.
  async getDuplicate(sourceKey) {
    const entry = await this.ctx.storage.get(`dup:${sourceKey}`);
    if (entry && Date.now() - entry.at < DUPLICATE_MS) return entry.deck;
    return null;
  }

  async rememberDuplicate(sourceKey, deck) {
    await this.ctx.storage.put(`dup:${sourceKey}`, { at: Date.now(), deck });
  }

  // Throws away old limit counters and duplicate memories (called by the cron).
  async cleanup() {
    const storage = this.ctx.storage;
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const doomed = [];
    for (const [key, value] of await storage.list({ prefix: "rl:" })) {
      if (!value.some((t) => now - t < HOUR_MS)) doomed.push(key);
    }
    for (const [key, value] of await storage.list({ prefix: "dup:" })) {
      if (now - value.at >= DUPLICATE_MS) doomed.push(key);
    }
    for (const key of (await storage.list({ prefix: "day:" })).keys()) {
      if (key !== `day:${today}`) doomed.push(key);
    }
    // delete() takes at most 128 keys at a time
    for (let i = 0; i < doomed.length; i += 100) await storage.delete(doomed.slice(i, i + 100));
  }

  // ------------------------------------------------------------ the gate itself

  // Runs tasks strictly one after another, in the order they arrive.
  enqueue(task) {
    const run = this.chain.then(task);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  baseHeaders() {
    return {
      "User-Agent": this.env.MOX_USER_AGENT,
      "x-moxfield-version": MOX_VERSION,
      Accept: "application/json",
    };
  }

  // The ONLY place a request to Moxfield is made. Waits for the 1.1 s gap,
  // honours the 60 s pause, and starts the pause on 403/429.
  // Returns { res } or { error }.
  async send(path, method, headers, body) {
    if (Date.now() < this.pausedUntil) return { error: "blocked" };

    const wait = this.lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();

    let res;
    try {
      res = await fetch(MOX_BASE + path, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      console.error("moxfield fetch failed", err && err.name);
      return { error: "network" };
    }
    console.log(`mox ${method} ${path.split("?")[0]} -> ${res.status}`);

    if (res.status === 403 || res.status === 429) {
      this.pausedUntil = Date.now() + PAUSE_MS;
      await this.ctx.storage.put("pausedUntil", this.pausedUntil);
      try {
        await res.body?.cancel();
      } catch {}
      return { error: "blocked" };
    }
    return { res };
  }

  // A normal signed-in call, with one retry if the token turns out to be stale.
  async doMox({ method, path, body }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await this.ensureToken(attempt > 0);
      if (auth.error) return auth;

      const headers = {
        ...this.baseHeaders(),
        Authorization: `Bearer ${auth.token.value}`,
        "X-Session-User": auth.token.userId,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const sent = await this.send(path, method, headers, body === undefined ? undefined : JSON.stringify(body));
      if (sent.error) return sent;

      const res = sent.res;
      if (res.status === 401) {
        try {
          await res.body?.cancel();
        } catch {}
        this.token = null;
        if (attempt === 0) continue; // refresh and try once more
        return { error: "auth" };
      }
      let data = null;
      try {
        data = JSON.parse(await res.text());
      } catch {
        data = null; // empty or not JSON
      }
      return { ok: res.ok, status: res.status, data };
    }
    return { error: "auth" };
  }

  async ensureToken(force) {
    if (!force && this.token && Date.now() < this.token.expiresAt - TOKEN_MARGIN_MS) {
      return { token: this.token };
    }
    return this.refresh();
  }

  // Cookies live in storage as { name: value }. If the owner changed the
  // MOX_REFRESH_COOKIE secret, start over from the new value (compared by
  // fingerprint, so the plain secret is never stored twice).
  async loadCookies() {
    const storage = this.ctx.storage;
    const secret = this.env.MOX_REFRESH_COOKIE || "";
    const fingerprint = await sha256Hex(secret);
    let cookies = await storage.get("cookies");

    if (secret && (!cookies || fingerprint !== (await storage.get("seedFp")))) {
      cookies = parseCookieString(secret);
      this.userId = "";
      this.token = null;
      await storage.put({ cookies, seedFp: fingerprint, userId: "" });
    }
    return cookies && Object.keys(cookies).length ? cookies : null;
  }

  // Gets a fresh access token. Every refresh rotates the cookies, so the new
  // ones are saved straight away, before anything else can go wrong.
  async refresh() {
    const cookies = await this.loadCookies();
    if (!cookies) return { error: "auth" };

    const headers = {
      ...this.baseHeaders(),
      "Content-Type": "application/json",
      Cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    };
    const sent = await this.send(
      "/v1/account/token/refresh",
      "POST",
      headers,
      JSON.stringify({ userId: this.userId, isAppLogin: false }),
    );
    if (sent.error) return sent;
    const res = sent.res;

    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {}
      // 5xx means Moxfield trouble; anything else (400/401...) means our cookies are no good.
      // The stored cookies are kept either way.
      return { error: res.status >= 500 ? "network" : "auth" };
    }

    // Save the rotated cookies FIRST.
    const fresh = readRefreshCookies(res);
    if (Object.keys(fresh).length) {
      Object.assign(cookies, fresh);
      await this.ctx.storage.put("cookies", cookies);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!data || typeof data.access_token !== "string" || !data.access_token) return { error: "auth" };

    const userId = data.user_id != null ? String(data.user_id) : this.userId;
    if (userId && userId !== this.userId) {
      this.userId = userId;
      await this.ctx.storage.put("userId", userId);
    }
    const minutes = Number(data.expires_in_minutes) > 0 ? Number(data.expires_in_minutes) : 15;
    this.token = { value: data.access_token, userId: this.userId, expiresAt: Date.now() + minutes * 60_000 };
    return { token: this.token };
  }
}

// "a=1; b=2" -> { a: "1", b: "2" }
function parseCookieString(text) {
  const cookies = {};
  for (const part of String(text).split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

// Pulls the new refresh_token* cookies out of a response's Set-Cookie headers.
function readRefreshCookies(res) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const fresh = {};
  for (const line of lines) {
    const pair = line.split(";")[0];
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (name.startsWith("refresh_token") && value) fresh[name] = value; // empty value = cookie being deleted
  }
  return fresh;
}
