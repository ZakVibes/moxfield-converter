# Put Your List On Mox

Paste a deck link from **Archidekt** or **ManaBox** and get the same deck back as a
**Moxfield** deck, posted on the [PutYourListOnMoxPlease](https://moxfield.com/users/PutYourListOnMoxPlease)
account. Free for everyone.

- `worker/` – the helper server (a Cloudflare Worker) that reads, converts and uploads decks.
- `tools/` – small test scripts used while building it.

Moxfield access is used with Moxfield's permission and kept under their rate limit
(at most 1 request per second). No secrets are stored in this repository.

The helper is deployed automatically by Cloudflare whenever `main` changes on GitHub.
