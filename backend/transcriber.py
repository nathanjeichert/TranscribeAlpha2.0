import os
import inspect
import time
import re
import logging
import shutil
from typing import Dict, List, Optional
import sys

# Python 3.9+ type hint compatibility
if sys.version_info >= (3, 9):
    from typing import Tuple
else:
    from typing import Tuple as typing_Tuple
    Tuple = typing_Tuple

import ffmpeg
from pydub import AudioSegment

try:
    from .models import TranscriptTurn, WordTimestamp
except ImportError:
    try:
        from models import TranscriptTurn, WordTimestamp
    except ImportError:
        import models
        TranscriptTurn = models.TranscriptTurn
        WordTimestamp = models.WordTimestamp

# AssemblyAI integration
try:
    import assemblyai as aai
    ASSEMBLYAI_AVAILABLE = True
except ImportError:
    ASSEMBLYAI_AVAILABLE = False
    logging.getLogger(__name__).warning("AssemblyAI SDK not installed. Run: pip install assemblyai")

# Configure both ffmpeg libraries to find ffmpeg
import subprocess
import platform

def find_executable_path(executable_name: str) -> Optional[str]:
    """Cross-platform executable finder"""
    # First try shutil.which (works on all platforms)
    path = shutil.which(executable_name)
    if path:
        return path
    
    # Platform-specific fallback commands
    system = platform.system().lower()
    if system == "windows":
        try:
            result = subprocess.run(['where', executable_name], capture_output=True, text=True, shell=True)
            if result.returncode == 0:
                return result.stdout.strip().split('\n')[0]
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(['which', executable_name], capture_output=True, text=True)
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
    
    return None

def get_ffprobe_path(ffmpeg_path: str) -> Optional[str]:
    """Get ffprobe path from ffmpeg path"""
    if not ffmpeg_path:
        return None
    
    # Get directory and base name
    ffmpeg_dir = os.path.dirname(ffmpeg_path)
    ffmpeg_name = os.path.basename(ffmpeg_path)
    
    # Replace ffmpeg with ffprobe, keeping the same extension
    if ffmpeg_name.endswith('.exe'):
        ffprobe_name = ffmpeg_name.replace('ffmpeg.exe', 'ffprobe.exe')
    else:
        ffprobe_name = ffmpeg_name.replace('ffmpeg', 'ffprobe')
    
    ffprobe_path = os.path.join(ffmpeg_dir, ffprobe_name)
    
    # Check if it exists
    if os.path.exists(ffprobe_path):
        return ffprobe_path
    
    # Try finding ffprobe independently
    return find_executable_path('ffprobe')

# Find ffmpeg and ffprobe
ffmpeg_executable_path = find_executable_path('ffmpeg')
ffprobe_executable_path = None

if ffmpeg_executable_path:
    ffprobe_executable_path = get_ffprobe_path(ffmpeg_executable_path)
    # Configure pydub
    AudioSegment.converter = ffmpeg_executable_path
    AudioSegment.ffmpeg = ffmpeg_executable_path
    if ffprobe_executable_path:
        AudioSegment.ffprobe = ffprobe_executable_path

SUPPORTED_VIDEO_TYPES = ["mp4", "mov", "avi", "mkv"]
SUPPORTED_AUDIO_TYPES = ["mp3", "wav", "m4a", "flac", "ogg", "aac", "aiff"]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
if ASSEMBLYAI_API_KEY and ASSEMBLYAI_AVAILABLE:
    aai.settings.api_key = ASSEMBLYAI_API_KEY
    aai.settings.http_timeout = 300.0
    logger.info("AssemblyAI client initialized successfully")
elif ASSEMBLYAI_AVAILABLE:
    logger.warning("ASSEMBLYAI_API_KEY environment variable not set")

_SPEAKER_LETTER_RE = re.compile(r"^[A-Z]$")
_SPEAKER_NUMERIC_RE = re.compile(r"^[0-9]+$")


def _normalize_speaker_label(raw_value: Optional[object], fallback: str = "SPEAKER A") -> str:
    """Normalize diarization labels so downstream exports use SPEAKER X.

    Internal to this module — the canonical version lives in transcript_utils.
    """
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


def _mark_continuation_turns(turns: List[TranscriptTurn]) -> List[TranscriptTurn]:
    """Mark turns as continuations when the same speaker has consecutive turns."""
    if not turns:
        return turns

    prev_speaker = None
    for turn in turns:
        normalized_speaker = turn.speaker.strip().upper()
        if prev_speaker is not None and normalized_speaker == prev_speaker:
            turn.is_continuation = True
        else:
            turn.is_continuation = False
        prev_speaker = normalized_speaker

    return turns


def convert_video_to_audio(input_path: str, output_path: str, format: str = "mp3") -> Optional[str]:
    try:
        logger.info("Converting %s to %s", input_path, output_path)

        if ffmpeg_executable_path:
            cmd = [
                ffmpeg_executable_path,
                '-i', input_path,
                '-acodec', 'libmp3lame',
                '-y',
                output_path
            ]
            logger.debug("Running command: %s", ' '.join(cmd))
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                logger.info("Successfully converted to %s", output_path)
                time.sleep(0.5)
                return output_path
            else:
                logger.error("ffmpeg failed with return code %d: %s", result.returncode, result.stderr)
                return None
        else:
            logger.debug("Using ffmpeg-python library as fallback")
            ffmpeg.input(input_path).output(output_path, format=format, acodec='libmp3lame').overwrite_output().run(quiet=True)
            return output_path
    except Exception as e:
        logger.error("Unexpected error in convert_video_to_audio: %s", e)
        return None


def build_assemblyai_config(speakers_expected: Optional[int] = None) -> "aai.TranscriptionConfig":
    """Build the AssemblyAI config used for legal transcription."""
    if not ASSEMBLYAI_AVAILABLE:
        raise RuntimeError("AssemblyAI SDK not installed. Run: pip install assemblyai")

    prompt = (
        "Produce a verbatim transcript. Include disfluencies and fillers (um, uh, er, ah, hmm, mhm, like, you know, I mean), "
        "repetitions (I I, the the), restarts (I was- I went), stutters (th-that, b-but), "
        "and informal speech (gonna, wanna, gotta)."
    )

    config_kwargs = {
        "speech_models": ["universal-3-pro"],
        "prompt": prompt,
        "format_text": True,
        "speaker_labels": True,
    }
    if speakers_expected is not None:
        config_kwargs["speakers_expected"] = speakers_expected

    # `temperature` is supported in newer SDK versions.
    if "temperature" in inspect.signature(aai.TranscriptionConfig).parameters:
        config_kwargs["temperature"] = 0.1
    else:
        logger.warning("AssemblyAI SDK does not support `temperature`; upgrade to assemblyai>=0.50.0")

    return aai.TranscriptionConfig(**config_kwargs)


def build_assemblyai_multichannel_config() -> "aai.TranscriptionConfig":
    """Build AssemblyAI config for channel-separated jail-call transcription."""
    if not ASSEMBLYAI_AVAILABLE:
        raise RuntimeError("AssemblyAI SDK not installed. Run: pip install assemblyai")

    prompt = (
        "Produce a verbatim transcript. Include disfluencies and fillers (um, uh, er, ah, hmm, mhm, like, you know, I mean), "
        "repetitions (I I, the the), restarts (I was- I went), stutters (th-that, b-but), "
        "and informal speech (gonna, wanna, gotta)."
    )

    config_kwargs = {
        "speech_models": ["universal-3-pro"],
        "prompt": prompt,
        "format_text": True,
        "multichannel": True,
    }
    if "temperature" in inspect.signature(aai.TranscriptionConfig).parameters:
        config_kwargs["temperature"] = 0.1
    else:
        logger.warning("AssemblyAI SDK does not support `temperature`; upgrade to assemblyai>=0.50.0")

    return aai.TranscriptionConfig(**config_kwargs)


def turns_from_assemblyai_response(response: object, include_timestamps: bool = True) -> List[TranscriptTurn]:
    """
    Convert an AssemblyAI transcript response into our TranscriptTurn format.

    Supports both the SDK Transcript wrapper (response.transcript) and the raw TranscriptResponse.
    """
    if not response:
        return []

    # SDK Transcript wrapper has `.transcript` (TranscriptResponse) and `.id`/`.status`.
    transcript = getattr(response, "transcript", None) or response

    utterances = getattr(transcript, "utterances", None) or []
    turns: List[TranscriptTurn] = []

    if utterances:
        for utterance in utterances:
            speaker_label = getattr(utterance, "speaker", None)
            speaker_name = _normalize_speaker_label(speaker_label, fallback="SPEAKER A")

            timestamp_str = None
            if include_timestamps and getattr(utterance, "start", None) is not None:
                start_ms = float(getattr(utterance, "start"))
                start_seconds = start_ms / 1000.0
                minutes = int(start_seconds // 60)
                seconds = int(start_seconds % 60)
                timestamp_str = f"[{minutes:02d}:{seconds:02d}]"

            word_timestamps: List[WordTimestamp] = []
            words = getattr(utterance, "words", None) or []
            for word in words:
                word_text = getattr(word, "text", "")
                if not word_text:
                    continue
                word_speaker_raw = getattr(word, "speaker", None)
                word_speaker = _normalize_speaker_label(word_speaker_raw, fallback=speaker_name)
                start_val = getattr(word, "start", None)
                end_val = getattr(word, "end", None)
                if start_val is None or end_val is None:
                    continue
                confidence_val = getattr(word, "confidence", None)
                word_timestamps.append(
                    WordTimestamp(
                        text=str(word_text),
                        start=float(start_val),
                        end=float(end_val),
                        confidence=float(confidence_val) if confidence_val is not None else None,
                        speaker=word_speaker,
                    )
                )

            turns.append(
                TranscriptTurn(
                    speaker=speaker_name,
                    text=str(getattr(utterance, "text", "") or ""),
                    timestamp=timestamp_str,
                    words=word_timestamps if word_timestamps else None,
                )
            )

        return _mark_continuation_turns(turns)

    # Fallback: no utterances (unexpected if speaker_labels is enabled).
    text_value = str(getattr(transcript, "text", "") or "").strip()
    if not text_value:
        return []

    turns.append(
        TranscriptTurn(
            speaker="SPEAKER A",
            text=text_value,
            timestamp="[00:00]" if include_timestamps else None,
            words=None,
        )
    )
    return turns


def turns_from_assemblyai_multichannel_response(
    response: object,
    channel_labels: Optional[Dict[int, str]] = None,
    include_timestamps: bool = True,
) -> List[TranscriptTurn]:
    """
    Convert an AssemblyAI multichannel response into TranscriptTurn format.

    AssemblyAI multichannel utterances include `channel` instead of `speaker`.
    """
    if not response:
        return []

    transcript = getattr(response, "transcript", None) or response
    utterances = getattr(transcript, "utterances", None) or []

    normalized_labels: Dict[int, str] = {}
    if channel_labels:
        for raw_key, raw_value in channel_labels.items():
            try:
                channel_index = int(raw_key)
            except (TypeError, ValueError):
                continue
            label = str(raw_value or "").strip()
            if channel_index > 0 and label:
                normalized_labels[channel_index] = label

    turns: List[TranscriptTurn] = []
    for utterance in utterances:
        channel_raw = getattr(utterance, "channel", None)
        try:
            channel_index = int(channel_raw)
        except (TypeError, ValueError):
            channel_index = 1

        speaker_name = normalized_labels.get(channel_index) or f"CHANNEL {channel_index}"

        timestamp_str = None
        if include_timestamps and getattr(utterance, "start", None) is not None:
            start_ms = float(getattr(utterance, "start"))
            start_seconds = start_ms / 1000.0
            minutes = int(start_seconds // 60)
            seconds = int(start_seconds % 60)
            timestamp_str = f"[{minutes:02d}:{seconds:02d}]"

        word_timestamps: List[WordTimestamp] = []
        words = getattr(utterance, "words", None) or []
        for word in words:
            word_text = getattr(word, "text", "")
            if not word_text:
                continue

            start_val = getattr(word, "start", None)
            end_val = getattr(word, "end", None)
            if start_val is None or end_val is None:
                continue

            confidence_val = getattr(word, "confidence", None)
            word_timestamps.append(
                WordTimestamp(
                    text=str(word_text),
                    start=float(start_val),
                    end=float(end_val),
                    confidence=float(confidence_val) if confidence_val is not None else None,
                    speaker=speaker_name,
                )
            )

        turns.append(
            TranscriptTurn(
                speaker=speaker_name,
                text=str(getattr(utterance, "text", "") or ""),
                timestamp=timestamp_str,
                words=word_timestamps if word_timestamps else None,
            )
        )

    if turns:
        return _mark_continuation_turns(turns)

    text_value = str(getattr(transcript, "text", "") or "").strip()
    if not text_value:
        return []

    fallback_speaker = normalized_labels.get(1) or "CHANNEL 1"
    return [
        TranscriptTurn(
            speaker=fallback_speaker,
            text=text_value,
            timestamp="[00:00]" if include_timestamps else None,
            words=None,
        )
    ]


def get_media_duration(file_path: str) -> Optional[float]:
    """Return the duration of an audio/video file in **seconds** using ffprobe.
    
    Uses the cross-platform ffprobe path detection.
    """
    if not ffprobe_executable_path:
        return None  # ffprobe not available

    try:
        cmd = [
            ffprobe_executable_path,
            "-i",
            file_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        duration_str = result.stdout.strip()
        if duration_str:
            return float(duration_str)
    except Exception as e:
        logger.debug("ffprobe duration extraction failed: %s", e)
    return None

