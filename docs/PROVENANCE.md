# Provenance of ported / vendored code

This project is licensed under **GPL-3.0** (see `LICENSE`). The UI and parts
of its logic are ports of GPL-3.0 code from the ProtonMail WebClients
monorepo; one dependency is vendored under BSD-3-Clause. Everything below was
verified against the referenced files at the recorded commit.

## ProtonMail WebClients (GPL-3.0)

Source: https://github.com/ProtonMail/WebClients (cloned locally at commit
`78f4d09`, 2026-10-30). Ported into this repo with attribution; logic ports
carry a comment at each site.

| Ported element | Reference file | Target |
| --- | --- | --- |
| Month-grid layout (collision groups, columns, `+N more` placement, `getIsAllSingle`) | `applications/calendar/src/app/components/calendar/layout.ts`, `useDayGridEventLayout.ts` | `js/app.js` (`layout`, `dayGridRowLayout`) |
| Week-row event splitting (all-day/part-day/multi-day index ranges, midnight-end handling) | `.../calendar/splitDayEventsInInterval.ts` | `js/app.js` (`splitDayEventsInInterval`) |
| Drag & drop (create-drag with 20px sensitivity, event move by index arithmetic, more-popover trigger, `blockClick`) | `.../calendar/interactions/dayGridMouseHandler.ts`, `.../calendar/mouseHelpers/{mathHelpers,domHelpers}.ts` | `js/app.js` (DnD section) |
| Day-grid DOM structure (weekday header, day buttons `aria-current`/`aria-pressed`, chip custom properties, `+N more`) | `.../calendar/DayGrid.tsx`, `DayGrid/DayButtons.tsx` | `js/app.js` (`renderMonth`), `index.html`, `css/style.css` |
| Event chip styling (all-day solid + 5px darker left bar, part-day dot+time+title, cancelled strikethrough, isDragging) | `.../components/events/{FullDayEvent,PartDayRegularEvent}.tsx` + `_eventcell.scss` | `css/style.css`, `js/app.js` (`eventChip`) |
| Event popover structure (color bar, title, date header, frequency line, icon rows, header actions) | `.../components/events/EventPopover.tsx`, `PopoverEventContent.tsx`, `_eventpopover.scss` | `js/app.js` (`openEventPopover`) |
| Modal surfaces (ModalTwo sizing/backdrop), form-row layout with icon column | `@proton/components` ModalTwo / EventForm | `css/style.css`, `js/app.js` (editor) |
| Design tokens: snow theme colors, structure sizes, radii, shadows, z-indexes, calendar metrics | `packages/colors/themes/dist/snow.theme.css`, `packages/styles/scss/lib/_config.scss`, `_init.scss`, calendar `_config.scss` | `css/style.css` (`:root`, commented) |
| Calendar color palette (20 accent colors) | `packages/shared/lib/colors.ts` `ACCENT_COLORS` | `js/calendar-core.js` (`PALETTE`) |
| Event color shades (2nd shade = HSL s−0.05, l−0.05) | `packages/colors/gen-accent-shades.ts`, `applications/calendar/src/app/helpers/color.ts` | `js/app.js` (`genAccentShades`) |
| Default calendar (`My calendar`, `ACCENT_COLORS[0]`) | `packages/shared/lib/calendar/constants.ts` `DEFAULT_CALENDAR` | `js/app.js` (bootstrap) |
| Default event duration (30 min) | same file, `DEFAULT_EVENT_DURATION` | `js/app.js` (`beginCreate`) |
| Frequency semantics (presets incl. weekday rule, per-occurrence editing scope) | `applications/calendar/src/app/components/eventModal/eventForm/*` | `js/app.js` (`FREQ_PRESETS`, `beginEdit`) |

Deviations from the ports are recorded in `docs/DEVIATIONS.md` and
`WORKLOG.MD` (e.g. the frequency-string formatter is a compact English-only
reimplementation of `getFrequencyString.ts`, which is i18n-bound).

## rrule.js (BSD-3-Clause)

`js/vendor/rrule.mjs` is rrule.js **2.8.1**, vendored verbatim from npm
(`rrule@2.8.1`, dist/es5/rrule.mjs at package publish). Licence copy:
`js/vendor/rrule.LICENCE`. Used for RRULE expansion on naive wall times.

## Everything else

The worker (`worker/`), the wire protocol implementation, the crypto layer
(`js/crypto.js`), the iCalendar codec (`js/ical.js`), the calendar core
(`js/calendar-core.js`), the CLI and the tests are original to this project
(see `WORKLOG.MD` for the full development record) and are covered by the
project's GPL-3.0 license.
