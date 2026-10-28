# MARVA frontend — React + Tailwind (mockup-faithful)

NEW folder. The live frontend `../frontend/index.html` is untouched.

## Layout (from the user mockup, 27 Oct 20:34 / 20:41 WIB)

- Header: MARVA + "Meta Audit Review Verification for Authors" + bell /
  help / avatar icons.
- Left column: Upload PDF (drag-drop + "Select PDF File", Info Document
  "Format: PDF • Max. 50MB"), Upload History, paste-text demo fallback.
- Right: Live Meeting Room — Pre-Submit Review Session, "Live • 7
  participants", 7 labelled agent tiles.
- Bottom: Meeting Log: Brief (agent + finding, from real events only)
  and Audit Progress (Structure, Completeness, Citations, Reference
  Consistency, Final — bar = real stages done / 5).
- Report area + Export JSON / Export HTML / Delete job buttons.

UI is English only.

## Meeting Room characters — honest closeness report

The 7 characters are hand-drawn animated SVG, NOT the mockup raster
image and NOT pixel-perfect to it. What matches: 7 furry characters,
colours and order (blue, mint/teal, purple, yellow, orange/peach,
cream with glasses, dark grey/black), table layout, poses (laptops,
paper in the purple character's hands, dark character back-to-viewer
at a laptop, glasses on the cream character). What does NOT match
pixel-for-pixel: fur grain/texture, photographic lighting and shading,
and the room background (the mockup is a generated photo-like image;
SVG shapes cannot reproduce it). Claiming pixel-perfect would be false.

Animation, all tied to real backend state:
- Blink: eyes close briefly on a per-character timer (different
  duration/delay per character, so blinks look random).
- Typing: hands/laptop bob only while that agent's stage is really
  running (inferred honestly: the backend only pushes an event when a
  stage finishes, so while a job is running the first stage with no
  event yet is shown as running). The Narrator types only while any
  real stage is running — it never produces a bubble of its own.
- Breathing/idle: slow scale while waiting.

## Honest-data rules (part of the spec, not optional)

- NOTHING is hardcoded from the mockup: no fixed progress percentage,
  no fixed time estimate, no example history filenames, no
  figure/formatting-completeness claims, no fake Narrator log line,
  no plagiarism percentage anywhere.
- History starts empty. Entries are added only from jobs actually
  created in this browser (PDF upload or pasted text), plus a synthetic
  demo entry only when the synthetic demo endpoint is actually called
  (labelled cached/demo, never presented as a job).
- Bubbles = latest real backend event details only, mapped to their
  agent. Meeting Log = every real event. Progress = real stages done.
- Export buttons call the backend endpoints
  `GET /jobs/:id/report.json` and `GET /jobs/:id/report.html`. If the
  backend returns 404 (the live Worker does not implement them yet),
  the UI says so honestly instead of generating a fake report.
- Delete calls `DELETE /jobs/:id`; if the backend returns 404, the UI
  says the job was NOT deleted server-side and offers a local-only
  history removal, labelled as such.
- Progress-stage mapping (mockup stages ← backend stages):
  Structure ← reader, Completeness ← gap, Citations ←
  citation_matcher, Reference Consistency ← reference_verifier,
  Final ← supervisor. Journal Matcher and strengthening have no
  mockup progress slot; they are shown on their tiles and in the
  report, never silently counted as another progress stage.

## Run

```sh
npm install
npm run dev        # local dev server
npm run build      # production build -> dist/
```

API base: env `VITE_API_BASE` (see `.env.example`). Default when
unset is the placeholder `https://marva-backend.onrender.com`, which
is filled in at deploy time with the real backend URL. No secret is
ever put in this repo or in env files committed here.

## Not done / known gaps

- Not deployed, not pushed to GitHub (per spec).
- Backend report endpoints (`report.json`, `report.html`) and
  `DELETE /jobs/:id` do not exist on the live Worker yet, so Export
  and Delete will report 404 honestly until the backend adds them.
- No SSE stream: the live backend serves events as JSON, so this
  frontend polls `GET /jobs/:id/events` every 2 seconds.
- The 50MB limit is enforced in the browser only; the backend's own
  request-size limit may reject large PDFs first.
- Room background is a flat gradient, not the mockup's photo-like
  office (see closeness report above).
