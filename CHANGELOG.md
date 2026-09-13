# Changelog

## 0.3.2 — 2026-09-13
- Added Chrome/Edge extension icon assets (16/32/48/128 px).
- No archive, image, or callout logic changes from 0.3.1.

## 0.3.1 — 2026-09-13
- Fixed User callout marker conversion by switching to an alphanumeric-only placeholder that survives HTML-to-Markdown escaping.

## 0.3.0 — 2026-09-13
- Preserves ChatGPT-protected user images with authenticated fetch and data-URL fallback.
- Removes citation favicons and UI-only image noise.
- Adds image preservation diagnostics (`protected/public/inline/failed`).
- Adds a separate text-only meta context for Obsidian Web Clipper Interpreter prompts.

## 0.2.0 — 2026-09-13
- Uses numeric `conversation-turn-N` IDs as canonical ordering.
- Verifies continuity before declaring the archive complete.
- Replaces ChatGPT `<main>` temporarily with the stable archive article so Web Clipper Reader/content extraction can see the whole thread.
- Adds multi-pass scrolling and recovery diagnostics.

## 0.1.0 — 2026-09-13
- Initial prototype for materializing virtualized ChatGPT turns before clipping.
