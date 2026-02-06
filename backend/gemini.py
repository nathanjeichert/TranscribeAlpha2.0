import json
import logging
import os
import re
import time
from typing import Any, List, Optional

from fastapi import HTTPException

logger = logging.getLogger(__name__)
_SPEAKER_LETTER_RE = re.compile(r"^[A-Z]$")
_SPEAKER_NUMERIC_RE = re.compile(r"^[0-9]+$")


def _speaker_suffix_for_index(index: int) -> str:
    """Convert 0-based index to A, B, ..., Z, AA, AB, ..."""
    value = max(index, 0)
    chars: List[str] = []
    while True:
        value, remainder = divmod(value, 26)
        chars.append(chr(ord("A") + remainder))
        if value == 0:
            break
        value -= 1
    return "".join(reversed(chars))


def _normalize_speaker_label(raw_value: Any, fallback: str) -> str:
    fallback_value = str(fallback or "").strip().upper() or "SPEAKER A"
    candidate = str(raw_value or "").strip()
    candidate = re.sub(r":+$", "", candidate).strip().upper()

    if not candidate:
        candidate = fallback_value

    if candidate == "UNKNOWN":
        return fallback_value

    if candidate.startswith("SPEAKER"):
        suffix = candidate[len("SPEAKER"):].strip()
        return f"SPEAKER {suffix}" if suffix else "SPEAKER"

    if _SPEAKER_LETTER_RE.fullmatch(candidate) or _SPEAKER_NUMERIC_RE.fullmatch(candidate):
        return f"SPEAKER {candidate}"

    return candidate


def run_gemini_edit(xml_text: str, audio_path: str, audio_mime: str, duration_hint: float) -> List[dict]:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if api_key:
        api_key = api_key.strip()
        if (api_key.startswith('"') and api_key.endswith('"')) or (api_key.startswith("'") and api_key.endswith("'")):
            api_key = api_key[1:-1].strip()
        if api_key in {"your-gemini-key-here", "YOUR_GEMINI_KEY_HERE"}:
            raise HTTPException(
                status_code=500,
                detail="GEMINI_API_KEY is still set to the placeholder value; update your Cloud Run env var or Cloud Build trigger substitution _GEMINI_API_KEY.",
            )
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")

    try:
        from google import genai
        from google.genai import types as genai_types
    except Exception as exc:
        logger.error("google-genai not available: %s", exc)
        raise HTTPException(status_code=500, detail="Gemini client library not installed") from exc

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-3-pro-preview").strip()
    if not model_name:
        model_name = "gemini-3-pro-preview"

    instructions = (
        "You are improving an OnCue-style legal transcript. "
        "Use the provided XML transcript and the audio to correct ONLY: wording errors, punctuation, capitalization, and speaker labels. "
        "CRITICAL: You MUST preserve the EXACT start and end timestamps from the original - do NOT modify timing values. "
        "Keep the same number of lines and line order. Only fix text content and speaker names."
    )

    polish_schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "speaker": {"type": "string"},
                "text": {"type": "string"},
                "start": {"type": "number"},
                "end": {"type": "number"},
            },
            "required": ["speaker", "text", "start", "end"],
        },
    }

    def wait_for_file_active(client: Any, file_name: str, *, timeout_seconds: int = 120) -> Any:
        deadline = time.time() + max(5, timeout_seconds)
        last_state = None
        while time.time() < deadline:
            fetched = client.files.get(name=file_name)
            state = getattr(fetched, "state", None)
            if state != last_state:
                logger.info("Gemini file %s state=%s", file_name, state)
                last_state = state
            if state == genai_types.FileState.ACTIVE:
                return fetched
            if state == genai_types.FileState.FAILED:
                err = getattr(fetched, "error", None)
                raise RuntimeError(f"Gemini file processing failed: {err}")
            time.sleep(2.0)
        raise TimeoutError("Timed out waiting for Gemini file to become ACTIVE")

    client = None
    uploaded = None
    try:
        client = genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(timeout=600_000),
        )
        upload_config = genai_types.UploadFileConfig(
            mime_type=audio_mime,
            display_name=os.path.basename(audio_path),
        )
        try:
            uploaded = client.files.upload(file=audio_path, config=upload_config)
        except Exception as exc:
            logger.exception("Failed to upload media to Gemini")
            exc_text = str(exc)
            if "API_KEY_INVALID" in exc_text or "API key not valid" in exc_text:
                logger.error(
                    "Gemini rejected API key (len=%s). Check for quotes/whitespace and correct key source.",
                    len(api_key or ""),
                )
            raise HTTPException(
                status_code=502,
                detail=(
                    "Uploading media to Gemini failed. "
                    "If this is an API key error, ensure `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set without quotes/whitespace "
                    "and is a valid Gemini Developer API key. "
                    f"({type(exc).__name__}: {exc})"
                ),
            ) from exc
        wait_timeout = int(os.getenv("GEMINI_FILE_ACTIVE_TIMEOUT_SECONDS", "120"))
        try:
            uploaded = wait_for_file_active(client, uploaded.name, timeout_seconds=wait_timeout)
        except Exception as exc:
            logger.exception("Uploaded file did not become ACTIVE")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini file processing failed ({type(exc).__name__}: {exc})",
            ) from exc

        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_text(text=instructions),
                    genai_types.Part.from_text(
                        text=f"Total duration (seconds): {duration_hint:.2f}. Existing XML transcript follows:\n{xml_text}"
                    ),
                    genai_types.Part.from_uri(
                        file_uri=uploaded.uri,
                        mime_type=uploaded.mime_type or audio_mime,
                    ),
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0.15,
                    response_mime_type="application/json",
                    response_json_schema=polish_schema,
                    thinking_config=genai_types.ThinkingConfig(thinking_level="low"),
                ),
            )
        except Exception as exc:
            logger.exception("Gemini generation failed")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini transcript refinement failed ({type(exc).__name__}: {exc})",
            ) from exc
    finally:
        if client and uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
        if client:
            try:
                client.close()
            except Exception:
                pass

    raw_text = getattr(response, "text", None) or getattr(response, "output_text", None)
    if not raw_text and getattr(response, "candidates", None):
        try:
            raw_text = response.candidates[0].content.parts[0].text
        except Exception:
            raw_text = None

    if not raw_text:
        logger.error("Gemini response missing text payload")
        raise HTTPException(status_code=502, detail="Gemini returned an empty response")

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini JSON: %s", exc)
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON") from exc

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Gemini response must be a list of line objects")

    normalized = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            continue
        speaker = _normalize_speaker_label(
            item.get("speaker", ""),
            fallback=f"SPEAKER {_speaker_suffix_for_index(idx)}",
        )
        text = str(item.get("text", "")).strip()
        start_val = float(item.get("start", 0.0))
        end_val = float(item.get("end", start_val))
        normalized.append(
            {
                "id": item.get("id") or f"gem-{idx}",
                "speaker": speaker,
                "text": text,
                "start": max(start_val, 0.0),
                "end": max(end_val, start_val),
                "is_continuation": False,
            }
        )

    if not normalized:
        raise HTTPException(status_code=502, detail="Gemini did not return any transcript lines")

    logger.info("Gemini polish completed with %d lines", len(normalized))
    return normalized


def transcribe_with_gemini(
    audio_path: str,
    audio_mime: str,
    duration_hint: float,
    speaker_name_list: Optional[List[str]] = None,
) -> List[dict]:
    """
    Transcribe audio using Gemini 3.0 Pro with thinking_level="low".

    Args:
        audio_path: Path to the audio file
        audio_mime: MIME type of the audio
        duration_hint: Approximate duration in seconds
        speaker_name_list: Optional list of speaker names to use

    Returns:
        List of transcript line objects with speaker, text, start, end fields
    """
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if api_key:
        api_key = api_key.strip()
        if (api_key.startswith('"') and api_key.endswith('"')) or (api_key.startswith("'") and api_key.endswith("'")):
            api_key = api_key[1:-1].strip()
        if api_key in {"your-gemini-key-here", "YOUR_GEMINI_KEY_HERE"}:
            raise HTTPException(
                status_code=500,
                detail="GEMINI_API_KEY is still set to the placeholder value; update your Cloud Run env var.",
            )
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")

    try:
        from google import genai
        from google.genai import types as genai_types
    except Exception as exc:
        logger.error("google-genai not available: %s", exc)
        raise HTTPException(status_code=500, detail="Gemini client library not installed") from exc

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-3-pro-preview").strip()
    if not model_name:
        model_name = "gemini-3-pro-preview"

    # Build speaker instructions
    speaker_instructions = ""
    if speaker_name_list and len(speaker_name_list) > 0:
        speaker_instructions = (
            f"Use these speaker names in order of appearance: {', '.join(speaker_name_list)}. "
            f"Expected number of speakers: {len(speaker_name_list)}. "
        )
    else:
        speaker_instructions = (
            "Identify and label distinct speakers as SPEAKER A, SPEAKER B, SPEAKER C, etc. "
        )

    instructions = (
        "You are a professional legal transcriptionist. "
        "Transcribe the provided audio file into a legal transcript format with precise WORD-LEVEL timestamps. "
        f"{speaker_instructions}"
        "Each utterance must include the 'words' array with timing for EVERY word in the text. "
        "Ensure proper punctuation and capitalization. "
        "All timestamps should be accurate in seconds, with start < end, entries non-overlapping and chronological."
    )

    def wait_for_file_active(client: Any, file_name: str, *, timeout_seconds: int = 120) -> Any:
        deadline = time.time() + max(5, timeout_seconds)
        last_state = None
        while time.time() < deadline:
            fetched = client.files.get(name=file_name)
            state = getattr(fetched, "state", None)
            if state != last_state:
                logger.info("Gemini file %s state=%s", file_name, state)
                last_state = state
            if state == genai_types.FileState.ACTIVE:
                return fetched
            if state == genai_types.FileState.FAILED:
                err = getattr(fetched, "error", None)
                raise RuntimeError(f"Gemini file processing failed: {err}")
            time.sleep(2.0)
        raise TimeoutError("Timed out waiting for Gemini file to become ACTIVE")

    client = None
    uploaded = None
    try:
        client = genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(timeout=600_000),
        )
        upload_config = genai_types.UploadFileConfig(
            mime_type=audio_mime,
            display_name=os.path.basename(audio_path),
        )
        try:
            uploaded = client.files.upload(file=audio_path, config=upload_config)
        except Exception as exc:
            logger.exception("Failed to upload media to Gemini")
            exc_text = str(exc)
            if "API_KEY_INVALID" in exc_text or "API key not valid" in exc_text:
                logger.error("Gemini rejected API key (len=%s). Check for quotes/whitespace.", len(api_key or ""))
            raise HTTPException(
                status_code=502,
                detail=(
                    "Uploading media to Gemini failed. "
                    f"({type(exc).__name__}: {exc})"
                ),
            ) from exc

        wait_timeout = int(os.getenv("GEMINI_FILE_ACTIVE_TIMEOUT_SECONDS", "120"))
        try:
            uploaded = wait_for_file_active(client, uploaded.name, timeout_seconds=wait_timeout)
        except Exception as exc:
            logger.exception("Uploaded file did not become ACTIVE")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini file processing failed ({type(exc).__name__}: {exc})",
            ) from exc

        # Build the JSON schema for structured output
        utterance_schema = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string"},
                    "text": {"type": "string"},
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "words": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "word": {"type": "string"},
                                "start": {"type": "number"},
                                "end": {"type": "number"},
                            },
                            "required": ["word", "start", "end"],
                        },
                    },
                },
                "required": ["speaker", "text", "start", "end", "words"],
            },
        }

        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_text(text=instructions),
                    genai_types.Part.from_text(
                        text=f"Total audio duration (seconds): {duration_hint:.2f}. Please transcribe the following audio:"
                    ),
                    genai_types.Part.from_uri(
                        file_uri=uploaded.uri,
                        mime_type=uploaded.mime_type or audio_mime,
                    ),
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0.15,
                    response_mime_type="application/json",
                    response_json_schema=utterance_schema,
                    thinking_config=genai_types.ThinkingConfig(thinking_level="low"),
                ),
            )
        except Exception as exc:
            logger.exception("Gemini transcription failed")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini transcription failed ({type(exc).__name__}: {exc})",
            ) from exc
    finally:
        if client and uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
        if client:
            try:
                client.close()
            except Exception:
                pass

    raw_text = getattr(response, "text", None) or getattr(response, "output_text", None)
    if not raw_text and getattr(response, "candidates", None):
        try:
            raw_text = response.candidates[0].content.parts[0].text
        except Exception:
            raw_text = None

    if not raw_text:
        logger.error("Gemini response missing text payload")
        raise HTTPException(status_code=502, detail="Gemini returned an empty response")

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini JSON: %s", exc)
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON") from exc

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Gemini response must be a list of utterance objects")

    speaker_mapping = {}
    if speaker_name_list:
        for i, name in enumerate(speaker_name_list):
            suffix = _speaker_suffix_for_index(i)
            speaker_mapping[f"SPEAKER {suffix}"] = name.upper()
            speaker_mapping[suffix] = name.upper()

    normalized = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            logger.warning("Skipping non-dict item at index %d", idx)
            continue

        speaker = _normalize_speaker_label(
            item.get("speaker", ""),
            fallback=f"SPEAKER {_speaker_suffix_for_index(idx)}",
        )

        if speaker in speaker_mapping:
            speaker = speaker_mapping[speaker]

        text = str(item.get("text", "")).strip()
        start_val = float(item.get("start", 0.0))
        end_val = float(item.get("end", start_val))

        raw_words = item.get("words", [])
        if not raw_words:
            logger.warning("Utterance at index %d missing words array", idx)

        words_data = []
        for word_item in raw_words:
            word_text = str(word_item.get("word", "")).strip()
            if not word_text:
                continue
            word_start = float(word_item.get("start", 0.0))
            word_end = float(word_item.get("end", word_start))
            words_data.append({
                "text": word_text,
                "start": max(word_start, 0.0),
                "end": max(word_end, word_start),
                "speaker": speaker,
            })

        line_data = {
            "id": item.get("id") or f"gem-{idx}",
            "speaker": speaker,
            "text": text,
            "start": max(start_val, 0.0),
            "end": max(end_val, start_val),
            "is_continuation": False,
            "words": words_data,
        }

        normalized.append(line_data)

    if not normalized:
        raise HTTPException(status_code=502, detail="Gemini did not return any transcript lines")

    prev_speaker = None
    for item in normalized:
        current_speaker = item.get("speaker", "").strip().upper()
        if prev_speaker is not None and current_speaker == prev_speaker:
            item["is_continuation"] = True
        else:
            item["is_continuation"] = False
        prev_speaker = current_speaker

    logger.info("Gemini transcription completed with %d utterances", len(normalized))
    return normalized
