// Reads a deck from Archidekt or ManaBox and turns it into one common shape.
// None of this touches Moxfield, so it needs no rate gate.
//
// Common deck shape:
//   { source, name, format (Moxfield key or null), artUrl, warnings: [],
//     commanders: [entry], boards: { mainboard: [entry], sideboard, maybeboard, companions } }
//   entry = { qty, name, set, cn, finish: "normal" | "foil" | "etched" }

import { UserError, MSG } from "./util.js";

const SOURCE_UA = "PutYourListOnMox/1.0 (+https://github.com/ZakVibes/moxfield-converter)";
const FETCH_TIMEOUT_MS = 15_000;

// Format keys Moxfield accepts.
export const MOXFIELD_FORMATS = new Set([
  "commander", "standard", "modern", "legacy", "vintage", "pauper", "pioneer", "historic",
  "timeless", "alchemy", "brawl", "historicBrawl", "oathbreaker", "pauperEdh", "predh",
  "premodern", "duelCommander", "gladiator", "pennyDreadful", "oldSchool", "none",
]);

// Archidekt's numeric deck formats (best effort).
const ARCHIDEKT_FORMATS = {
  1: "standard", 2: "modern", 3: "commander", 4: "legacy", 5: "vintage", 6: "pauper",
  13: "brawl", 14: "oathbreaker", 15: "pioneer", 16: "historic", 17: "pauperEdh",
  20: "historicBrawl", 21: "gladiator", 22: "premodern", 23: "predh", 24: "timeless",
};

// ManaBox format names, with spaces/punctuation/case removed.
const MANABOX_FORMATS = {
  commander: "commander", edh: "commander", standard: "standard", modern: "modern",
  legacy: "legacy", vintage: "vintage", pauper: "pauper", pioneer: "pioneer",
  historic: "historic", timeless: "timeless", alchemy: "alchemy", brawl: "brawl",
  standardbrawl: "brawl", historicbrawl: "historicBrawl", oathbreaker: "oathbreaker",
  paupercommander: "pauperEdh", pauperedh: "pauperEdh", predh: "predh",
  premodern: "premodern", duelcommander: "duelCommander", gladiator: "gladiator",
  pennydreadful: "pennyDreadful", oldschool: "oldSchool",
};

// ----------------------------------------------------------------- the link

// Returns { source, id, key } or null. `key` is the normalised link used for
// the "already converted" memory.
export function parseSourceUrl(raw) {
  const text = String(raw || "").trim();
  let m = text.match(/^(?:https?:\/\/)?(?:www\.)?archidekt\.com\/decks\/(\d{1,12})(?:[/?#]|$)/i);
  if (m) return { source: "archidekt", id: m[1], key: `archidekt:${m[1]}` };
  m = text.match(/^(?:https?:\/\/)?(?:www\.)?manabox\.app\/decks\/([A-Za-z0-9_-]{6,64})(?:[/?#]|$)/i);
  if (m) return { source: "manabox", id: m[1], key: `manabox:${m[1]}` };
  return null;
}

export async function readDeck(src) {
  const deck = src.source === "archidekt" ? await readArchidekt(src.id) : await readManabox(src.id);
  return finalizeDeck(deck);
}

// ----------------------------------------------------------------- shared bits

async function fetchSource(url, accept) {
  try {
    return await fetch(url, {
      headers: { "User-Agent": SOURCE_UA, Accept: accept },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new UserError(MSG.sourceDown);
  }
}

function makeEntry(qty, name, set, cn, finishText) {
  const finish = /etched/i.test(finishText || "") ? "etched" : /foil/i.test(finishText || "") ? "foil" : "normal";
  return {
    qty: Math.max(1, Math.floor(Number(qty)) || 1),
    name: String(name || "").replace(/[\r\n]+/g, " ").trim(),
    set: set ? String(set).trim() : "",
    cn: cn != null ? String(cn).trim() : "",
    finish,
  };
}

// Fills in the format and checks the deck isn't empty.
function finalizeDeck(deck) {
  if (!deck.format || !MOXFIELD_FORMATS.has(deck.format)) {
    deck.format = deck.commanders.length ? "commander" : "none";
  }
  const total =
    deck.commanders.length + Object.values(deck.boards).reduce((n, list) => n + list.length, 0);
  if (!total) throw new UserError(MSG.emptyDeck);
  deck.name = (deck.name || "").trim() || "Imported deck";
  return deck;
}

export function sumQty(entries) {
  return entries.reduce((n, e) => n + e.qty, 0);
}

// "1 Sol Ring (CMM) 703 *F*"
export function entryLine(e) {
  let line = `${e.qty} ${e.name}`;
  if (e.set) line += ` (${e.set.toUpperCase()})`;
  if (e.cn) line += ` ${e.cn}`;
  if (e.finish === "foil") line += " *F*";
  else if (e.finish === "etched") line += " *E*";
  return line;
}

export function boardText(entries) {
  return entries.map(entryLine).join("\n");
}

// ----------------------------------------------------------------- Archidekt

async function readArchidekt(id) {
  const res = await fetchSource(`https://archidekt.com/api/decks/${id}/`, "application/json");
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    throw new UserError(MSG.archidektPrivate);
  }
  if (!res.ok) throw new UserError(MSG.sourceDown);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new UserError(MSG.sourceDown);
  }
  if (!data || !Array.isArray(data.cards)) throw new UserError(MSG.archidektPrivate);

  // Categories that Archidekt keeps out of the deck count (maybeboard-like).
  const excluded = new Set();
  for (const cat of data.categories || []) {
    if (cat && cat.includedInDeck === false && cat.name) excluded.add(String(cat.name).toLowerCase());
  }

  const deck = {
    source: "archidekt",
    name: data.name,
    format: ARCHIDEKT_FORMATS[data.deckFormat] || null,
    artUrl: null,
    warnings: [],
    commanders: [],
    boards: { mainboard: [], sideboard: [], maybeboard: [], companions: [] },
  };
  let firstCommanderUid = null;

  for (const item of data.cards) {
    const card = item && item.card;
    const name = card && card.oracleCard && card.oracleCard.name;
    if (!name) continue;
    const entry = makeEntry(
      item.quantity,
      name,
      card.edition && card.edition.editioncode,
      card.collectorNumber,
      item.modifier,
    );
    const cats = (Array.isArray(item.categories) ? item.categories : []).map((c) => String(c).toLowerCase());

    // Order matters: commander first, then companion, sideboard, maybeboard.
    if (cats.includes("commander")) {
      deck.commanders.push(entry);
      if (!firstCommanderUid && card.uid) firstCommanderUid = card.uid;
    } else if (item.companion === true) {
      deck.boards.companions.push(entry);
    } else if (cats.includes("sideboard")) {
      deck.boards.sideboard.push(entry);
    } else if (cats.includes("maybeboard") || cats.some((c) => excluded.has(c))) {
      deck.boards.maybeboard.push(entry);
    } else {
      deck.boards.mainboard.push(entry);
    }
  }

  if (firstCommanderUid && /^[0-9a-f-]{36}$/i.test(firstCommanderUid)) {
    deck.artUrl = `https://api.scryfall.com/cards/${firstCommanderUid}?format=image&version=art_crop`;
  }
  return deck;
}

// ----------------------------------------------------------------- ManaBox

async function readManabox(id) {
  const res = await fetchSource(`https://manabox.app/decks/${id}`, "text/html");
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new UserError(MSG.manaboxPrivate);
  if (!res.ok) throw new UserError(MSG.sourceDown);
  const html = await res.text();

  // The deck is stored inside <astro-island props="..."> attributes.
  // Find the biggest one that mentions boardCategory.
  let best = null;
  let pos = html.indexOf("<astro-island");
  while (pos !== -1) {
    const next = html.indexOf("<astro-island", pos + 1);
    const limit = next === -1 ? html.length : next;
    const start = html.indexOf(' props="', pos);
    if (start !== -1 && start < limit) {
      const from = start + ' props="'.length;
      const to = html.indexOf('"', from); // quotes inside are escaped, so this is the end
      if (to !== -1) {
        const raw = html.slice(from, to);
        if (raw.includes("boardCategory") && (!best || raw.length > best.length)) best = raw;
      }
    }
    pos = next;
  }
  if (!best) throw new UserError(MSG.manaboxPrivate);

  let props;
  try {
    props = decodeAstro(JSON.parse(unescapeHtml(best)));
  } catch {
    throw new UserError(MSG.sourceDown);
  }

  const cards = collectCards(props);
  if (!cards.length) throw new UserError(MSG.emptyDeck);
  const meta = findDeckMeta(props);

  const deck = {
    source: "manabox",
    name: typeof meta.name === "string" ? meta.name : "",
    format: typeof meta.format === "string" ? MANABOX_FORMATS[meta.format.toLowerCase().replace(/[^a-z0-9]/g, "")] || null : null,
    artUrl: typeof meta.imageUrl === "string" && /^https:\/\//i.test(meta.imageUrl) ? meta.imageUrl : null,
    warnings: [],
    commanders: [],
    boards: { mainboard: [], sideboard: [], maybeboard: [], companions: [] },
  };
  const oddCategories = new Set();

  for (const c of cards) {
    const entry = makeEntry(c.quantity, c.name, c.setId, c.collectorNumber, c.variant);
    switch (c.boardCategory) {
      case 0: deck.commanders.push(entry); break;
      case 3: deck.boards.mainboard.push(entry); break;
      case 4: deck.boards.sideboard.push(entry); break;
      case 5: deck.boards.maybeboard.push(entry); break;
      default:
        deck.boards.maybeboard.push(entry);
        oddCategories.add(String(c.boardCategory));
    }
  }
  if (oddCategories.size) {
    deck.warnings.push("Some cards were in a ManaBox section this tool doesn't know, so they went to the maybeboard.");
  }
  return deck;
}

// &quot; &amp; &#39; &lt; &gt; and numeric entities, in one pass.
function unescapeHtml(text) {
  const named = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">" };
  return text.replace(/&(?:(quot|amp|apos|lt|gt)|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name, dec, hex) => {
    if (name) return named[name];
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

// Astro wraps every value as [type, value]. 0 = plain, 1 = list; other types
// (dates, maps...) just keep their value.
function decodeAstro(v) {
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "number") {
      const [type, value] = v;
      if (type === 1 && Array.isArray(value)) return value.map(decodeAstro);
      if (type === 0 && value && typeof value === "object") return decodeAstro(value);
      return value;
    }
    return v.map(decodeAstro);
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const key of Object.keys(v)) out[key] = decodeAstro(v[key]);
    return out;
  }
  return v;
}

// Every object that has both boardCategory and name, de-duplicated by internalId.
function collectCards(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]); // keeps original order
      continue;
    }
    if ("boardCategory" in v && typeof v.name === "string") {
      if (v.internalId != null) {
        if (seen.has(v.internalId)) continue;
        seen.add(v.internalId);
      }
      found.push(v);
      continue;
    }
    for (const key of Object.keys(v)) stack.push(v[key]);
  }
  return found;
}

// The deck's own details (name, format, image).
function findDeckMeta(root) {
  if (root && root.deck && typeof root.deck === "object" && !Array.isArray(root.deck)) return root.deck;
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (!Array.isArray(v) && Array.isArray(v.cards) && typeof v.name === "string") return v;
    for (const key of Object.keys(v)) stack.push(v[key]);
  }
  return {};
}
