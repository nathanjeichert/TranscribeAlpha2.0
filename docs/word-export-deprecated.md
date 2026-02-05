# Word/DOCX Export Deprecation

## Status
- Deprecated as of 2026-02-05.
- Canonical transcript exports are now `PDF + OnCue XML` (oncue variant) and `PDF + HTML Viewer` (criminal variant).

## Why
- Word layout is not deterministic enough for strict page/line parity.
- The PDF pipeline is driven by precomputed wrapped line entries, so page/line assignments stay aligned across PDF, XML, and HTML viewer outputs.

## Legacy Code Location
- All Word/DOCX-specific logic is isolated in:
  - `backend/word_legacy.py`

This module is legacy-only. Do not add new output features there.

## Compatibility
- DOCX import remains available as a deprecated compatibility path.
- Existing sessions that only have `docx_base64` can still be read by frontend fallbacks.
- New/updated sessions should emit and persist `pdf_base64`.

## Engineering Rule
- If export layout behavior must change, update the shared line-entry model and PDF renderer in `backend/transcript_formatting.py`, then ensure XML/HTML continue consuming the same line entries.
