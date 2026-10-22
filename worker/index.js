// Cloudflare Worker - firewall test.
// Only runs at /run-test; every other address does nothing, so stray visits
// (browser tab icons, bots) can't trigger requests to Moxfield.
// Each run: 2 requests to Moxfield, 1.2 s apart. Never shows the secret.

const DECK_URL = "https://api2.moxfield.com/v3/decks/all/h5OHZ1Tt7kWmsbinG9a_aQ"; // unlisted "API test" deck
const VERSION = "2026.10.21.2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryFetch(userAgent) {
  const headers = { "x-moxfield-version": VERSION };
  if (userAgent) headers["User-Agent"] = userAgent;
  try {
    const res = await fetch(DECK_URL, { headers });
    const text = await res.text();
    const name = (text.match(/"name":"([^"]*)"/) || [])[1] || null;
    return { status: res.status, deckName: name };
  } catch (e) {
    return { error: String(e) };
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/run-test") {
      return new Response("Nothing here.", { status: 404 });
    }
    const hasSecret = Boolean(env.MOX_USER_AGENT);
    const withSecret = hasSecret ? await tryFetch(env.MOX_USER_AGENT) : "secret not set";
    await sleep(1200);
    const withoutSecret = await tryFetch(null);
    return Response.json({ secretIsSet: hasSecret, withSecretUserAgent: withSecret, withoutUserAgent: withoutSecret }, { headers: { "Cache-Control": "no-store" } });
  },
};
