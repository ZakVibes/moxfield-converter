// Builds the deck on Moxfield. Every call goes through the MoxGate object,
// which keeps them one second apart and handles sign-in.

import { UserError, MSG, GATE_ERRORS } from "./util.js";
import { MOXFIELD_FORMATS, boardText, sumQty } from "./sources.js";

// One gated Moxfield call; turns gate failures into friendly errors.
async function mox(gate, method, path, body) {
  const r = await gate.mox({ method, path, body });
  if (r.error) throw new UserError(GATE_ERRORS[r.error] || MSG.generic);
  return r;
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const frontFace = (s) => norm(s).split(" // ")[0];

// Same card? Accepts "A // B" on one side and just "A" on the other.
function sameName(wanted, found) {
  const w = norm(wanted);
  const f = norm(found);
  return w === f || frontFace(w) === f || w === frontFace(f);
}

// Looks a card up by name; returns Moxfield's card id or null.
async function findCardId(gate, entry) {
  const names = [entry.name];
  if (entry.name.includes(" // ")) names.push(entry.name.split(" // ")[0].trim()); // second try
  for (const name of names) {
    const r = await mox(gate, "GET", `/v2/cards/search?q=${encodeURIComponent(name)}`);
    const items = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : [];
    const matches = items.filter((c) => c && c.id && sameName(entry.name, c.name));
    if (!matches.length) continue;
    const exact = matches.find(
      (c) => entry.set && entry.cn && norm(c.set) === norm(entry.set) && norm(c.cn) === norm(entry.cn),
    );
    return (exact || matches[0]).id;
  }
  return null;
}

// How a "not found" item from Moxfield looks is unknown, so accept anything.
function errorItemName(item) {
  if (typeof item === "string") return item.slice(0, 120);
  if (item && typeof item === "object") {
    for (const key of ["name", "originalText", "line", "text", "message"]) {
      if (typeof item[key] === "string" && item[key]) return item[key].slice(0, 120);
    }
    try {
      return JSON.stringify(item).slice(0, 120);
    } catch {}
  }
  return String(item).slice(0, 120);
}

const countOr = (value, fallback) => (typeof value === "number" && value >= 0 ? value : fallback);

// Creates the deck and fills it. Returns the "deck" object of the result event.
export async function uploadDeck(gate, deck) {
  const warnings = [...deck.warnings];

  // 1. Commanders are set when the deck is created, so look their ids up first.
  const commanderIds = [];
  const commandersSet = [];
  const commandersToMain = [];
  deck.commanders.forEach((cmd, index) => {
    if (index >= 2) commandersToMain.push({ cmd, why: "Moxfield only takes two commanders" });
  });
  for (const cmd of deck.commanders.slice(0, 2)) {
    const id = await findCardId(gate, cmd);
    if (id) {
      commanderIds.push(id);
      commandersSet.push(cmd);
    } else {
      commandersToMain.push({ cmd, why: "couldn't find it on Moxfield" });
    }
  }
  for (const { cmd, why } of commandersToMain) {
    warnings.push(`Commander "${cmd.name}": ${why}, so it was added to the main deck instead.`);
  }

  // 2. Create the (empty) deck.
  const format = MOXFIELD_FORMATS.has(deck.format) ? deck.format : "none";
  const createBody = {
    name: deck.name.slice(0, 100),
    format,
    visibility: "unlisted",
    importText: "",
    pricingProvider: "cardkingdom",
    usePrefPrintings: false,
  };
  if (commanderIds[0]) createBody.commanderCardId = commanderIds[0];
  if (commanderIds[1]) createBody.partnerCardId = commanderIds[1];

  // Moxfield answers isSuccessful:false here because 0 cards were imported (the
  // deck is created empty on purpose), so the deck id is what proves it worked.
  const created = await mox(gate, "POST", "/v3/decks", createBody);
  const made = (created.data && created.data.deck) || {};
  const publicId = String(made.publicId || (created.data && created.data.publicId) || "");
  if (!created.ok || !/^[\w-]+$/.test(publicId)) {
    throw new UserError(MSG.createFailed);
  }
  const publicUrl =
    typeof made.publicUrl === "string" && made.publicUrl.startsWith("https://")
      ? made.publicUrl
      : `https://moxfield.com/decks/${publicId}`;

  // 3. Fill every board in one go.
  const mainEntries = [...deck.boards.mainboard, ...commandersToMain.map((x) => x.cmd)];
  const text = {
    mainboard: boardText(mainEntries),
    sideboard: boardText(deck.boards.sideboard),
    maybeboard: boardText(deck.boards.maybeboard),
    companions: boardText(deck.boards.companions),
  };
  const counts = {
    mainboard: sumQty(mainEntries),
    sideboard: sumQty(deck.boards.sideboard),
    maybeboard: sumQty(deck.boards.maybeboard),
    companions: sumQty(deck.boards.companions),
  };
  const notFound = [];

  if (Object.values(text).some(Boolean)) {
    const edit = await mox(gate, "PUT", `/v3/decks/${publicId}/bulk-edit`, {
      boards: {
        ...text,
        attractions: "",
        stickers: "",
        contraptions: "",
        planes: "",
        schemes: "",
        tokens: "",
      },
      pricingProvider: "cardkingdom",
      usePrefPrintings: false,
      ignoreFlavorNames: false,
      allowMultiplePrintings: true,
    });
    const reply = edit.data;
    if (!edit.ok || !reply || (reply.isSuccessful === false && !reply.boardSummary)) {
      throw new UserError(MSG.fillFailed);
    }

    // Prefer Moxfield's own counts over ours.
    const bc = (reply.boardSummary && reply.boardSummary.boardCounts) || {};
    for (const board of Object.keys(counts)) counts[board] = countOr(bc[board], counts[board]);

    const boardErrors = (reply.errors && reply.errors.boards) || {};
    for (const [board, list] of Object.entries(boardErrors)) {
      for (const item of Array.isArray(list) ? list : list ? [list] : []) {
        if (notFound.length < 200) notFound.push({ name: errorItemName(item), board });
      }
    }
  }
  // Commanders aren't part of the bulk-edit boards, so add them to the main count.
  counts.mainboard += commandersSet.length;
  if (notFound.length) warnings.push("Moxfield couldn't find some cards. They are listed below.");

  return {
    name: createBody.name,
    url: publicUrl,
    publicId,
    commanders: commandersSet.map((c) => c.name),
    format,
    visibility: "unlisted",
    counts,
    artUrl: deck.artUrl,
    source: deck.source,
    notFound,
    warnings,
  };
}
