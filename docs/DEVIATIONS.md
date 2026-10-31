# Protocol deviations, interpretations & scope notes

This PoC implements **only the calendar feature** of PROTOCOL v4.1 (per the
owner's instruction). Everything below was decided on documented evidence and
is mirrored in `WORKLOG.MD` (decisions D1–D16). Anything NOT listed here
follows the specification verbatim.

## Scope

- **Implemented**: §4 auth + silent drop, §5 encoding/error policy, §6 row
  envelope (server side), §7 storage (DO SQLite primary + D1 backup), §8
  bootstrap/config/rewrap, §9 row sync (GET/PUT/DELETE), §10 status,
  §13 calendar buckets (client side: 23-day window, ownership, 16/day cap,
  RMW/rebase), §19 daily backup (calendar scope), §22 versioning.
- **Excluded by owner's order**: photos (§15–§18: no R2, no blob routes,
  `photo_pending` is therefore always 0), todos (§14).
- **§11 WebSocket radar omitted**: it exists for clock-status and alarm
  events only — the specification defines **no row-change nudge frame**; row
  sync is pull-based via the `GET /rows` manifest. No clock exists in this
  PoC. The clock's §13 reader behaviour (render today + 7 days from cached
  buckets) is represented by the read-only **Clock preview** panel.

## Spec findings (report to owner)

1. **§8 `wrapped` length is internally inconsistent** — `"48B = 12B nonce ||
   32B ct+tag"` cannot hold a 32-byte master key with a 16-byte GCM tag.
   Implemented the only valid reading: `wrapped = nonce(12) || ct(32) ||
   tag(16)` = **60 bytes** (mirrors §2/§15.1 `KPHOTO_WRAPPED_LEN 48 = 32 ct +
   16 tag`, where 48 counts only the ct+tag portion).
2. **§3 vs §8 conflict on `GET /config`** — §3's unlock flow fetches
   `/config` *before* any key exists, yet §8 requires AUTH_UI/AUTH_CLOCK
   (both derived *from* config). Resolution: `/config` stays authenticated
   (keeps L3 intact); the web client provisions AUTH_UI once via a **setup
   link** (`?setup=<hex64>`), the browser analogue of the clock's NVS
   "setup channel".
3. **§3 omits the literal HKDF info string for K_data** — implemented as
   `"clock-v4/K_data"` following the documented `"clock-v4/<domain>"`
   pattern (`AUTH_UI`/`AUTH_CLOCK`/`K_photo_wrap` are explicit in §3).

## Deliberate decisions

- **Web writer prefix `w:`** (§13 defines `d:`/`t:` for the phone forks that
  do not exist here). Ownership rules are enforced verbatim: a writer never
  modifies another prefix's entries.
- **CORS allowlist** (not in the spec — native clients don't need it; a
  GitHub Pages browser client does): only `https://sh-clock.github.io`.
  Preflight `OPTIONS` is exempt from the bearer gate (browsers never send
  `Authorization` on preflight). Foreign origins get **no** CORS headers, so
  the browser itself enforces the silent drop. No cookies → no CSRF surface.
- **Bootstrap enforces `iters == 100000`** (§2 protocol constant, visible in
  the clear).
- **New rows accept any `ver >= 1`** — required by §19's restore drill, which
  PUTs verbatim envelopes with preserved `ver` onto a fresh server.
- **Rebase detection uses envelope identity** (`nonce` echo), not `ver`
  alone: when `incoming.ver == stored.ver` the returned `ver` equals the
  submitted one, so `ver` alone cannot distinguish accept from rebase (§9).
- **Row id cap 256 chars**; request bodies capped at 1 MiB (server-visible
  size hygiene; the largest legal calendar body is ~90 KB).
- **`config.ver` increments on rewrap**; rewrap/GET-config on an
  un-bootstrapped server → `404 {"error":"not_found"}` (§5
  authenticated-but-missing).
- **Auth model** (from §4 + §5 together): admin routes accept only
  ADMIN_SECRET (anything else is "wrong-secret /bootstrap" → empty 404);
  app routes accept only AUTH_UI/AUTH_CLOCK at the bearer gate, and within
  them PUT/DELETE rows require the UI class → `403` empty body ("capability
  violation, e.g. clock writing rows"). The `Bearer` scheme token format is
  matched strictly (64 lowercase hex).
- **D1 backup writes happen inside the Durable Object** (`POST
  /internal/backup`, gated by INTERNAL_TOKEN — a server-internal capability);
  the Worker's daily 03:00 UTC cron triggers it. Backups store BLOB
  `nonce`/`ct` verbatim; retention prunes days older than 7; a 14-day sweep
  clears `staged` (always empty in calendar scope).
- **`ADMIN_SECRET` / `INTERNAL_TOKEN`** are 64-char lowercase hex so every
  token class shares the same strict parsing and constant-time comparison.

## Security posture of this PoC (by design, per owner)

- Password is the user-designated test value `password` (the spec's §2
  40-character minimum is therefore intentionally NOT enforced — a client-side
  convention the owner waived for this PoC).
- The master key AES1 is a **dummy** generated at bootstrap and delivered to
  the owner out-of-band. Nothing here is production-secure; the crypto
  construction, however, is the protocol's real one (PBKDF2 → AES-GCM →
  HKDF, all native WebCrypto/Node crypto).

## Explicitly out of PoC scope (documented exclusions)

- **§20 Type B rotation** (AES1 compromise: drain, quiet window, full
  re-encryption of every row, re-wrapping of k_photo fields, token rotation).
  The Type A route (`PUT /bootstrap/rewrap`, same AES1) IS implemented and
  tested, including the CLI `--rewrap` mode and the AES1/AUTH-token-unchanged
  invariants. Type B is a rare structural drill that does not serve the
  calendar PoC; it would reuse the same RMW machinery that the suite already
  proves.
- **§11 WebSocket radar** (see above), **§14 todos**, **§15–§18 photos** —
  per the owner's scope order.
- The delivered setup link uses the `#setup=` **fragment** form (also
  supported: `?setup=` query) — fragments are not transmitted to the static
  host, keeping the provisioning token out of CDN/access logs.

---

## PROTOCOL v4.2 (calendar delta, 2026-10-31) — client-enforced conventions

The worker-side change of v4.2 is exactly the §22 version string (see
docs/PROTOCOL-v4.2.md). The following v4.2 conventions are enforced by the
CLIENT only (the server stays content-blind, L1/D16):

- `evt:{cal}:{uid}` row payload = one RFC 5545 VCALENDAR (one UID per row:
  master + RECURRENCE-ID exceptions); UID ≤ 200 chars, no `:` (row-id law).
- `cmeta:{uuid}` payload JSON `{v:1, name≤100, color #rrggbb}`.
- RRULE whitelist: FREQ = DAILY|WEEKLY|MONTHLY|YEARLY only (FREQ-first per
  RFC 5545 §3.3.10; SECONDLY/MINUTELY/HOURLY rejected — clock ecosystem
  scale). Rows violating the row rules above are treated as corrupt
  (surfaced, never rewritten).
- §13b projection ids: `x:{pid}` with `{pid}` = deterministic UUID-shaped
  hash of (calendar, UID) — keeps the v4.1 `[a-z]:{uuid}` grammar valid for
  foreign UIDs and disambiguates the same UID across calendars.
- Derived bucket titles are capped at 500 chars (§13 title law) at
  derivation; empty summaries project as `(untitled)`.
- Two-master rows, duplicate RECURRENCE-IDs, exceptions on a non-recurring
  master, duplicate single-occurring VEVENT properties → corrupt row.
- Zero DURATION (`PT0S`) is accepted (RFC dur-value grammar) = zero-length
  event; un-parseable EXDATE/RDATE value forms (e.g. PERIOD) round-trip
  verbatim instead of destroying the row.
- Client-side evt payload soft cap 200,000 chars (unreachable before the
  server's 64 KiB ciphertext law rejects the write).

## FullCalendar rework (v4.4 UI, 2026-10-31)

The view layer was replaced with vendored FullCalendar v6.1.22 (see
docs/PROVENANCE.md). Native FullCalendar behaviours that differ from the
previous Proton port — deliberately kept AS SHIPPED (user directive: do not
tweak their drag/resize; copy verbatim):

- **Event-title truncation is hard CLIP** (`overflow:hidden`, no ellipsis) —
  FullCalendar v6's own CSS for `.fc-event-title`.
- **Resize handles are hidden until hover/selection** (`.fc-event
  .fc-event-resizer { display:none }` + `:hover/:selected` display:block) —
  v6's own affordance design.
- **Month-view `prev()` re-anchors the current date to the month start**
  (range-start navigation), so a month→week switch after next/prev can show
  a different week than "today's". Native navigation semantics.
- **The `today` toolbar button is disabled when the current view already
  contains today** — native state management.
- **All-day select ranges are EXCLUSIVE at the end** (converted to the
  editor's inclusive display-end with a −1 day shift).
- **scrollTime is captured at calendar construction / resetOptions** — long
  sessions re-entering day/week/custom views scroll to the unlock-time hour
  rather than "now" (cosmetic; F-A5-5 accepted).
- **Overlap tiling is side-by-side with width splitting** (native), and the
  "+N more" popovers, now-indicator, navLinks and toolbar are native.
- **Recurring timed↔all-day conversion drags are refused** (toast + revert):
  converting flips the master's value type while RECURRENCE-ID exceptions
  keep theirs, which the row grammar rejects (audit F-A1-4). Users edit such
  events via the editor instead.
- **White event text on the 20-colour Proton palette**: #F78400, #3CBB3A and
  #B4A40E measure 2.5–2.6:1 against #FFFFFF (below WCAG 3:1). The palette
  and chip styling are Proton-verbatim (ACCENT_COLORS); colours are
  user-choosable. Inherited from the reference design, documented here
  rather than silently altered.
- **Pre-existing (not a rework regression, kept verbatim):** editing an
  event created in a foreign timezone converts DTSTART to the browser's
  wall time while the kept TZID parameter survives the RMW spread — the
  event can shift on reload. Same behaviour as the pre-rework client.

### Adapter audit (A2) — accepted minors
- **Zero-length timed events** (DTEND = DTSTART, creatable only by setting
  identical editor times): FullCalendar drops a non-positive `end` and
  renders the event at `defaultTimedEventDuration` (1 h); resizing such an
  event anchors to the model start. Niche; the editor's swap rule makes
  zero-length an explicit user choice.
- **Floating (TZID-less) timed events** render as UTC rather than
  observer-local (RFC 5545 §3.3.5). No in-app producer writes floating
  times (editor and conversions always stamp the browser IANA zone);
  latent interop edge for foreign clients only.
- **`startDelta` on resize is ignored** — safe while
  `eventResizableFromStart` stays at its default `false` (verified in the
  vendored bundle).
