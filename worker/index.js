// Put Your List On Mox - the helper server (Cloudflare Worker).
//
//   GET  /api/health    -> {"ok":true}
//   POST /api/convert   -> streams one JSON object per line (NDJSON):
//        {"type":"step","step":"read"|"convert"|"upload","state":"active"|"done"|"error"}
//        {"type":"queue","ahead":n}
//        {"type":"result","deck":{...}}      <- success, always the last line
//        {"type":"dryrun","deck":{...}}      <- only for dryRun:true
//        {"type":"error","message":"..."}    <- failure, always the last line
//
// All Moxfield traffic lives in gate.js (one call per second, for everyone).

import { MoxGate } from "./gate.js";
import { parseSourceUrl, readDeck, boardText, sumQty } from "./sources.js";
import { uploadDeck } from "./moxfield.js";
import { UserError, MSG, sha256Hex } from "./util.js";

export { MoxGate }; // Cloudflare needs the Durable Object class exported from the entry file

const ALLOWED_ORIGINS = ["https://zakvibes.github.io", "http://localhost:8000", "http://localhost:8010"];
const MAX_BODY_CHARS = 4000;

const getGate = (env) => env.MOX_GATE.get(env.MOX_GATE.idFromName("gate"));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      return Response.json({ ok: true }, { headers: { ...cors, "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/convert" && request.method === "POST") {
      return handleConvert(request, env, ctx, cors);
    }
    return new Response("Nothing here.", { status: 404, headers: cors });
  },

  // Weekly cron: keeps the Moxfield cookies fresh (they die after 30 days unused).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getGate(env).keepAlive());
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { Vary: "Origin" };
}

// ---------------------------------------------------------------- streaming

async function handleConvert(request, env, ctx, cors) {
  let text = "";
  try {
    text = await request.text();
  } catch {}
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let streamOpen = true;
  let finished = false; // true once a result/error/dryrun line was sent

  const send = async (event) => {
    if (event.type === "result" || event.type === "error" || event.type === "dryrun") finished = true;
    if (!streamOpen) return;
    try {
      await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
    } catch {
      streamOpen = false; // the visitor left; keep working quietly so the deck still gets finished
    }
  };

  const work = (async () => {
    try {
      await convert(env, ip, text, send);
    } catch (err) {
      if (!(err instanceof UserError)) console.error("convert failed", err && err.name);
      if (!finished) await send({ type: "error", message: err instanceof UserError ? err.message : MSG.generic });
    }
    if (!finished) await send({ type: "error", message: MSG.generic }); // the stream must always end properly
    try {
      await writer.close();
    } catch {}
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------- the job

async function convert(env, ip, bodyText, send) {
  let body;
  try {
    if (bodyText.length > MAX_BODY_CHARS) throw new Error("too long");
    body = JSON.parse(bodyText);
  } catch {
    throw new UserError(MSG.badRequest);
  }
  if (!body || typeof body !== "object" || typeof body.url !== "string") throw new UserError(MSG.badRequest);
  const dryRun = body.dryRun === true;

  const src = parseSourceUrl(body.url);
  if (!src) throw new UserError(MSG.badLink);

  const gate = getGate(env);

  // Same link converted a moment ago? Hand back the same result, no Moxfield calls.
  if (!dryRun) {
    const earlier = await gate.getDuplicate(src.key);
    if (earlier) {
      for (const step of ["read", "convert", "upload"]) await send({ type: "step", step, state: "done" });
      await send({ type: "result", deck: earlier });
      return;
    }
  }

  const ipHash = await sha256Hex(ip);
  const limit = await gate.checkLimit(ipHash, dryRun ? "dry" : "real", dryRun);
  if (!limit.ok) throw new UserError(limit.message);

  let step = "read";
  try {
    await send({ type: "step", step: "read", state: "active" });
    const deck = await readDeck(src);
    await send({ type: "step", step: "read", state: "done" });

    step = "convert";
    await send({ type: "step", step: "convert", state: "active" });
    const text = {
      mainboard: boardText(deck.boards.mainboard),
      sideboard: boardText(deck.boards.sideboard),
      maybeboard: boardText(deck.boards.maybeboard),
      companions: boardText(deck.boards.companions),
    };
    await send({ type: "step", step: "convert", state: "done" });

    if (dryRun) {
      await send({
        type: "dryrun",
        deck: {
          name: deck.name,
          format: deck.format,
          commanders: deck.commanders.map((c) => ({ name: c.name, set: c.set, cn: c.cn, finish: c.finish })),
          boards: text,
          counts: {
            mainboard: sumQty(deck.boards.mainboard) + deck.commanders.length, // commanders count toward the 100
            sideboard: sumQty(deck.boards.sideboard),
            maybeboard: sumQty(deck.boards.maybeboard),
            companions: sumQty(deck.boards.companions),
          },
          artUrl: deck.artUrl,
          warnings: deck.warnings,
        },
      });
      return;
    }

    // Count it against the visitor's limit now that it will really use Moxfield.
    step = "upload";
    const commit = await gate.checkLimit(ipHash, "real", true);
    if (!commit.ok) throw new UserError(commit.message);

    await send({ type: "step", step: "upload", state: "active" });
    const job = await gate.beginJob();
    if (job.ahead > 0) await send({ type: "queue", ahead: job.ahead });
    let result;
    try {
      result = await uploadDeck(gate, deck);
    } finally {
      await gate.endJob(job.id).catch(() => {});
    }
    // The deck exists now, so a failure to remember it must not turn into an error.
    await gate.rememberDuplicate(src.key, result).catch(() => {});
    await send({ type: "step", step: "upload", state: "done" });
    await send({ type: "result", deck: result });
  } catch (err) {
    await send({ type: "step", step, state: "error" });
    throw err; // the caller turns it into the final error line
  }
}
