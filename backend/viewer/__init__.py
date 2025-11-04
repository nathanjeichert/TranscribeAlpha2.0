"""HTML viewer rendering utilities."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

_TEMPLATE_CACHE: str | None = None
_PLACEHOLDER = "__TRANSCRIPT_JSON__"


def _load_template() -> str:
    global _TEMPLATE_CACHE
    if _TEMPLATE_CACHE is None:
        template_path = Path(__file__).with_name("template.html")
        _TEMPLATE_CACHE = template_path.read_text(encoding="utf-8")
    return _TEMPLATE_CACHE


def render_viewer_html(payload: Dict[str, Any]) -> str:
    """Render the standalone HTML viewer with embedded transcript payload."""
    template = _load_template()
    json_blob = json.dumps(payload, ensure_ascii=False)
    safe_blob = json_blob.replace("</script>", "<\\/script>")
    return template.replace(_PLACEHOLDER, safe_blob)
