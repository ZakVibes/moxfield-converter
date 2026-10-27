// Small shared helpers and the friendly messages shown to users.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hex SHA-256 of a string (used to fingerprint the cookie secret and, with a
// secret salt, to avoid storing raw IP addresses).
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// An error whose message is safe and friendly to show to the person converting.
export class UserError extends Error {}

export const MSG = {
  badLink: "Paste a deck link from Archidekt or ManaBox.",
  badRequest: "Something was wrong with that request. Paste a deck link and try again.",
  archidektPrivate: "That Archidekt deck is private or doesn't exist.",
  manaboxPrivate: "That ManaBox deck is private or doesn't exist.",
  sourceDown: "Couldn't read that deck right now. Try again in a minute.",
  emptyDeck: "That deck has no cards in it, so there is nothing to convert.",
  blocked: "Moxfield is busy or blocked this request. Try again in a few minutes.",
  authExpired: "The converter's Moxfield sign-in has expired. The owner needs to renew it.",
  network: "Couldn't reach Moxfield. Try again in a minute.",
  config: "The converter isn't set up correctly. The owner needs to check it.",
  createFailed: "Moxfield wouldn't create the deck. Try again in a few minutes.",
  fillFailed: "Moxfield created the deck but wouldn't fill it in. Try again in a few minutes.",
  generic: "Something went wrong on the converter. Try again in a minute.",
};

// Maps the short error codes the gate returns to the messages above.
export const GATE_ERRORS = {
  blocked: MSG.blocked,
  auth: MSG.authExpired,
  network: MSG.network,
  config: MSG.config,
};
