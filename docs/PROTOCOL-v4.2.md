# PROTOCOL v4.2 — calendar extension delta

2026-10-31. Additive minor bump over v4.1 (§22: "more opaque bytes, same
trust model"). Everything not stated here is v4.1 verbatim. The server change
is exactly one line: `GET /version` → `{"proto":"4.2"}` — v4.2 defines new
ROW TYPES on the existing flat, type-blind row store (§6/§9); no new routes,
no new server logic, no new auth classes. A v4.1 clock is expected to ignore
unknown row ids in the `GET /rows` manifest (it addresses `cal:{yyyymmdd}`
ids only); note the v4.1 base spec mandates tolerance only for unknown JSON
FIELDS (§22), not unknown row ids — the compatibility rests on v4.1 readers
addressing their own id namespace, as the clock does (§13). No v4.1 client
exists to test against (PoC), so this is a design expectation, not a proven
property.

## Purpose

v4.1's calendar model (§13 day buckets) serves the clock's display window
only: 23 live buckets, ≤16 events/day, no duration, no recurrence, no
multiple calendars. Phone-fork calendar sync (DAVx5) and a full web calendar
require the complete CalDAV data model. v4.2 therefore splits the calendar
domain into:

- **source of truth**: per-event rows carrying standard **iCalendar**
  (RFC 5545) payloads, plus per-calendar metadata rows;
- **derived clock cache**: the v4.1 §13 day buckets, regenerated from the
  event rows (format unchanged).

## CalDAV feature mapping (why iCalendar payloads)

The phone fork is a DAVx5 fork; its entire sync stack consumes iCalendar. By
storing RFC 5545 VCALENDAR text inside the encrypted envelopes, every
CalDAV-relevant data feature is met structurally, with no translation layer:

| CalDAV concept | v4.2 realization |
| --- | --- |
| calendar collection | `cmeta:{uuid}` row |
| displayname, calendar-color | `cmeta` payload fields `name`, `color` |
| resource URL / href | row id `evt:{cal}:{uid}` |
| ETag | row `ver` (decimal string form when compared) |
| PROPFIND member listing / WebDAV-Sync token | `GET /rows` manifest (id, ver) — clients diff the sets; absence after presence = deletion |
| calendar-multiget REPORT | per-row `GET /rows/{id}` (payload decrypted to iCalendar text) |
| PUT with If-Match (lost-update detection) | `PUT /rows/{id}` with `ver = stored.ver + 1`; a lost race returns the CURRENT envelope (§9 rebase) which the client MUST treat as a failed precondition |
| VEVENT fields (DTSTART/DTEND/SUMMARY/DESCRIPTION/LOCATION/RRULE/EXDATE/RECURRENCE-ID/VALARM/STATUS/TRANSP/SEQUENCE/UID) | carried verbatim inside the iCalendar payload |
| timezones (TZID) | IANA tz database names in `TZID` parameters; clients resolve with their platform tz database (browsers: `Intl`; Android: `libcore`); VTIMEZONE components are NOT stored (no embedded tz rules — single-user ecosystem, all clients have tz databases) |
| all-day events | `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` (floating day granularity) |
| recurring events | master VEVENT with `RRULE` (+ `EXDATE`, `RDATE`); exceptions as additional VEVENTs with `RECURRENCE-ID` inside the SAME row (one row per UID) |
| delete | `DELETE /rows/{id}` |

Not applicable (single-user, no scheduling): free-busy, scheduling (iTIP),
sharing, principals/ACLs. Not carried: VTODO/VJOURNAL (todos are §14's
domain), attendees/organizer (no scheduling; Proton-style email features are
out of the debloated client scope and out of the ecosystem's design).

## Row types

### `cmeta:{uuid}` — calendar metadata (new)

- writer: AUTH_UI (any UI writer; last-writer-wins per `ver`, §14-style)
- payload JSON:
  `{"v":1,"name":"<displayname ≤100 chars>","color":"<#rrggbb>"}`
  (`color` from the Proton 20-color accent palette recommended for visual
  parity across clients: `#8080FF #DB60D6 #EC3E7C #F78400 #936D58 #5252CC
  #A839A4 #BA1E55 #C44800 #54473F #415DF0 #179FD9 #1DA583 #3CBB3A #B4A40E
  #273EB2 #0A77A6 #0F735A #258723 #807304` — recommendation only, the server
  never sees it)
- one row per calendar. Deleting a calendar = delete its `cmeta` row (and,
  by client convention, its `evt` rows).
- id cap: `cmeta:` + uuid4 (36 chars) = 42 chars ≤ D9's 256.

### `evt:{cal}:{uid}` — event (new)

- id: `evt:` + calendar uuid + `:` + iCalendar UID. `{uid}` is the RFC 5545
  UID string (davx5 generates UUIDs for new events; the web client
  generates `crypto.randomUUID()`). The UID MUST NOT contain `:` and MUST
  be ≤ 200 chars (D9 id cap: `evt:`(4) + 36 + 1 + UID ≤ 256 ⇒ UID ≤ 215;
  200 keeps margin).
- writer: AUTH_UI, **writer-agnostic** (any UI writer may write any evt
  row — CalDAV resource semantics; conflicts resolve by `ver`, i.e.
  last-writer-wins per row, exactly §14's policy). The §13 ownership law
  applies to day-bucket entries only, NOT to evt rows.
- payload: complete RFC 5545 `VCALENDAR` text (UTF-8), containing exactly
  one event UID: the master VEVENT plus (for recurring events) its
  RECURRENCE-ID exception VEVENTs. `VERSION:2.0`, `PRODID`, `CALSCALE` are
  conventional; clients MUST ignore unknown properties/components
  (forward compatibility, §22 spirit).
- envelope size: typical event ≈ 300–800 B ≪ ROW_CT_MAX 64 KiB; a series
  with many exceptions is bounded by ROW_CT_MAX like any row.
- no sync window: evt rows live from creation until DELETE, independent of
  the 23-bucket clock window. The manifest is the working-set definition.
- moving an event to another calendar = client-side DELETE +
  create-`evt:{newcal}:{uid}` (CalDAV move semantics; row ids embed the
  calendar).

### `cal:{yyyymmdd}` — day buckets (v4.1 §13, now derived)

Unchanged wire format and window rotation. Semantics change: buckets are a
**projection cache** of the evt rows for the clock (v4.1 clocks are
unaffected — they only read). UI writers regenerate bucket contents after
evt-row mutations and at sync time:

- projection is **idempotent and complete per day**: the writer recomputes
  the full entry set for a day from ALL evt rows (the union is derived, so
  concurrent writers converge by §9's ver rebase without ownership loss);
- entry ids use the prefix **`x:{pid}`** where `{pid}` is a
  deterministic UUID-shaped hash of `(calendar uuid, event UID)`.
  `x` = derived projection namespace, distinguishing v4.2-derived entries
  from v4.1-authored `d:`/`t:`/`w:` entries; `{pid}` keeps the v4.1
  event-id grammar `[a-z]:{uuid}` valid even when the source UID is a
  foreign non-UUID form (e.g. `…@google.com` — DAVx5 preserves such UIDs
  verbatim) or the same UID exists in two calendars (the move procedure).
  The same `x:{pid}` appears in every day the event touches.
  **Normative algorithm** (implementations MUST port it verbatim —
  `projIdHash` in `js/calendar-core.js` is the reference):
  let `s` = the UTF-16 string `"<calendar uuid>|<event UID>"`; keep four
  32-bit lanes seeded `0x811c9dc5`, `0x01000193`, `0xdeadbeef`,
  `0x41c6ce57`; for each UTF-16 code unit `c` of `s` at index `i`, for
  each lane `j` in 0..3: `lane[j] = imul(lane[j] XOR ((c + j*0x9e37) AND
  0xffff), 0x01000193) >>> 0`. Hex-encode the four lanes big-endian,
  concatenate to a 32-hex-char string `h`; the id is
  `h[0..8] + "-" + h[8..12] + "-5" + h[13..16] + "-a" + h[17..20] + "-"
  + h[20..32]` (version nibble 5, variant nibble a fixed; 120 effective
  hash bits);
- per-day entry: `{id, date, hh, mm, title, priority}` where hh:mm is the
  event's LOCAL time in its own TZID (single-user ecosystem: clock and
  owner devices share a timezone in practice; bucket days are local days);
  all-day events project at `hh=0, mm=0` with `priority=1` (timed events
  project with `priority=2`; under §13's 0=highest scale all-day
  therefore outranks timed);
  multi-day events project one entry per covered day;
- the ≤16/day cap remains: derived entries drop by (priority, then id) —
  deterministic so every writer derives the identical dropped set;
- ABSENT buckets are rebuildable from evt rows; a corrupt bucket is
  still never blindly overwritten by a writer that cannot decrypt it
  (v4.1 rule retained) — a corrupt day heals only after rotation
  brings it back into the window, or via an admin force re-bootstrap.

## Sync algorithm (client law; server unchanged)

1. `GET /rows` manifest.
2. cmeta rows → calendar set (new: create; absent: delete calendar locally).
3. evt rows: diff (id, ver) against the local cache; `GET` + decrypt
   changed rows; locally-deleted rows → `DELETE /rows/{id}`; remote-absent
   rows → remove locally.
4. mutations: read the row's current ver (or know it from the cache),
   `PUT` with ver+1; a returned envelope that is not the submitted one
   (D14 nonce-echo identity check) = concurrent write → re-read, re-apply
   (or surface conflict; last-writer-wins by policy).
5. after mutations and at sync: regenerate affected `cal:{yyyymmdd}`
   buckets (window days only) and rotate the window per §13.

## Client payload schema conventions (iCalendar)

Not wire law (encrypted, server-blind), but REQUIRED for interop between
the web client, the DAVx5 fork, and future clients:

- DTSTAMP on every write (RFC 5545 §3.8.7.2 mandates it);
- SEQUENCE bumped on meaningful updates;
- the web client writes: UID, DTSTAMP, DTSTART, DTEND (or DURATION),
  SUMMARY, DESCRIPTION?, LOCATION?, TRANSP?, STATUS?, RRULE?, EXDATE?,
  RECURRENCE-ID exceptions, VALARM (one per reminder, `TRIGGER:-PTnnM`, `ACTION:DISPLAY`)
  when the user sets a reminder;
- the DAVx5 fork writes whatever Android CalendarProvider holds (its
  existing generator — `AndroidEventHandler` — unchanged, verbatim reuse);
- floating local times (no TZID, no Z) are interpreted in the client's
  local timezone; the web client always writes TZID-qualified or DATE
  values (never floating timed values).
