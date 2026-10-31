# Provenance of ported / vendored code

This project is licensed under **GPL-3.0** (see `LICENSE`). The UI and parts
of its logic are ports of GPL-3.0 code from the ProtonMail WebClients
monorepo; one dependency is vendored under BSD-3-Clause. Everything below was
verified against the referenced files at the recorded commit.

## ProtonMail WebClients (GPL-3.0)

Source: https://github.com/ProtonMail/WebClients (cloned locally at commit
`78f4d09`, 2026-10-30). Ported into this repo with attribution; logic ports
carry a comment at each site.

| Retained element | Reference file | Target |
| --- | --- | --- |
| Design tokens: snow theme colors, structure sizes, radii, shadows, z-indexes | `packages/colors/themes/dist/snow.theme.css`, `packages/styles/scss/lib/_config.scss`, `_init.scss` | `css/style.css` (`:root`, commented) + dark block (lumo-dark) |
| Calendar color palette (20 accent colors) | `packages/shared/lib/colors.ts` `ACCENT_COLORS` | `js/calendar-core.js` (`PALETTE`) |
| Event color shades (2nd shade = HSL s−0.05, l−0.05) | `packages/colors/gen-accent-shades.ts` | `js/app.js` (`genAccentShades`) |
| Default calendar (`My calendar`, `ACCENT_COLORS[0]`) | `packages/shared/lib/calendar/constants.ts` `DEFAULT_CALENDAR` | `js/app.js` (bootstrap) |
| Default event duration (30 min) | same file, `DEFAULT_EVENT_DURATION` | `js/app.js` (`beginCreate`) |
| Frequency semantics (presets incl. weekday rule, per-occurrence editing scope) | `applications/calendar/src/app/components/eventModal/eventForm/*` | `js/app.js` (`FREQ_PRESETS`, `beginEdit`) |
| Event popover structure (color bar, title, date header, frequency line, icon rows) | `.../components/events/EventPopover.tsx`, `_eventpopover.scss` | `js/app.js` (`openEventPopover`), `css/style.css` |
| Modal surfaces (ModalTwo sizing/backdrop), form-row layout with icon column | `@proton/components` ModalTwo / EventForm | `css/style.css`, `js/app.js` (editor) |

**Historical (v4.3, REMOVED by the FullCalendar rework):** the month-grid
layout engine (`layout.ts` ports), day/week/custom TimeGrid, year view,
day-grid/time-grid mouse handlers and the mini-grid DOM structure were
Proton ports living in `js/app.js` + `css/style.css` at commits before
`95aefd2` (git history preserves them under GPL-3.0).

Deviations from the ports are recorded in `docs/DEVIATIONS.md` and
`WORKLOG.MD` (e.g. the frequency-string formatter is a compact English-only
reimplementation of `getFrequencyString.ts`, which is i18n-bound).

## rrule.js (BSD-3-Clause)

`js/vendor/rrule.mjs` is rrule.js **2.8.1**, vendored verbatim from npm
(`rrule@2.8.1`, dist/es5/rrule.mjs at package publish). Licence copy:
`js/vendor/rrule.LICENCE`. Used for RRULE expansion on naive wall times.

## FullCalendar (MIT)

The calendar view layer is **FullCalendar v6.1.22** (© Adam Shaw,
https://github.com/fullcalendar/fullcalendar, MIT). The six official
prebuilt browser bundles are vendored VERBATIM (byte-identical from
`npm pack @fullcalendar/<pkg>@6.1.22`) with each package's MIT licence:

| Package | File | Provides |
| --- | --- | --- |
| `@fullcalendar/core` | `js/vendor/fullcalendar/core/index.global.min.js` | engine, `FullCalendar` global, CSS (runtime-injected) |
| `@fullcalendar/daygrid` | `js/vendor/fullcalendar/daygrid/index.global.min.js` | month view |
| `@fullcalendar/timegrid` | `js/vendor/fullcalendar/timegrid/index.global.min.js` | week/day/custom views |
| `@fullcalendar/interaction` | `js/vendor/fullcalendar/interaction/index.global.min.js` | drag & drop, resizing, selection (used as shipped) |
| `@fullcalendar/multimonth` | `js/vendor/fullcalendar/multimonth/index.global.min.js` | year view |
| `@fullcalendar/list` | `js/vendor/fullcalendar/list/index.global.min.js` | agenda view |

Selection rationale (verified, see WORKLOG "FULLCALENDAR UI REWORK"): the
npm `latest` line (v7) is a types-only stub over a new headless engine;
the classic plugin architecture with official prebuilt bundles lives in
the maintained **legacy line 6.1.22**. The app drives it exclusively
through documented options and public classes; no internals are patched.
MIT is GPL-compatible (licence texts retained per package).

## Everything else

The worker (`worker/`), the wire protocol implementation, the crypto layer
(`js/crypto.js`), the iCalendar codec (`js/ical.js`), the calendar core
(`js/calendar-core.js`), the CLI and the tests are original to this project
(see `WORKLOG.MD` for the full development record) and are covered by the
project's GPL-3.0 license.
