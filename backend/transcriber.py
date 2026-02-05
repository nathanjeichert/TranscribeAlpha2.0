import os
import io
import json
import inspect
import time
import re
import tempfile
import logging
import shutil
from typing import List, Optional
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
    logger.info("AssemblyAI client initialized successfully")
elif ASSEMBLYAI_AVAILABLE:
    logger.warning("ASSEMBLYAI_API_KEY environment variable not set")

def mark_continuation_turns(turns: List[TranscriptTurn]) -> List[TranscriptTurn]:
    """
    Mark turns as continuations when the same speaker has consecutive turns.

    The first turn of each speaker block gets is_continuation=False (shows speaker label).
    Subsequent turns with the same speaker get is_continuation=True (no speaker label).
    """
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


def get_audio_mime_type(ext: str) -> Optional[str]:
    mime_map = {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "aiff": "audio/aiff",
        "aac": "audio/aac",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }
    return mime_map.get(ext.lower())


def transcribe_with_assemblyai(
    audio_path: str,
    speaker_name_list: Optional[List[str]] = None,
    include_timestamps: bool = True
) -> Optional[List[TranscriptTurn]]:
    """
    Transcribe audio using AssemblyAI with speaker diarization and word-level timestamps.

    Args:
        audio_path: Path to audio file (local file path)
        speaker_name_list: Optional list of speaker names to map to AssemblyAI's labels
        include_timestamps: Whether to include timestamps in output

    Returns:
        List of TranscriptTurn objects with word-level timing data, or None on failure

    Note:
        AssemblyAI labels speakers as "A", "B", "C", etc. This function maps them to
        provided speaker names or generates generic identifiers like "SPEAKER A".
    """
    if not ASSEMBLYAI_AVAILABLE:
        logger.error("AssemblyAI SDK not available")
        return None

    if not ASSEMBLYAI_API_KEY:
        logger.error("ASSEMBLYAI_API_KEY not configured")
        return None

    def _build_primary_config() -> "aai.TranscriptionConfig":
        # Configure transcription with speaker diarization
        prompt = (
            "Produce a verbatim legal transcript. Include every word from each speaker, "
            "including disfluencies and fillers (um, uh, er, ah, hmm, mhm, like, you know, I mean), "
            "repetitions (I I, the the), restarts (I was- I went), stutters (th-that, b-but), "
            "and informal speech (gonna, wanna, gotta). Do not omit or normalize disfluencies."
        )

        # Prefer Universal-3 Pro but include Universal-2 fallback for broader language/model availability.
        config_kwargs = {
            "speech_models": ["universal-3-pro", "universal-2"],
            "language_detection": True,
            "prompt": prompt,
            "disfluencies": True,
            "format_text": True,
            "speaker_labels": True,
            "speakers_expected": len(speaker_name_list) if speaker_name_list else None,
        }

        # `temperature` is supported in newer SDK versions.
        if "temperature" in inspect.signature(aai.TranscriptionConfig).parameters:
            config_kwargs["temperature"] = 0.1
        else:
            logger.warning("AssemblyAI SDK does not support `temperature`; upgrade to assemblyai>=0.50.0")

        return aai.TranscriptionConfig(**config_kwargs)

    def _build_legacy_config() -> "aai.TranscriptionConfig":
        # Final fallback for API/runtime combinations that reject speech_models.
        raw_config = aai.RawTranscriptionConfig(
            language_model="slam_1",
            acoustic_model="slam_1",
        )
        return aai.TranscriptionConfig(
            speaker_labels=True,
            speakers_expected=len(speaker_name_list) if speaker_name_list else None,
            raw_transcription_config=raw_config,
        )

    try:
        logger.info(f"Starting AssemblyAI transcription for: {audio_path}")
        logger.info(
            "Speaker diarization enabled, expected speakers: %s",
            len(speaker_name_list) if speaker_name_list else "auto-detect",
        )

        transcriber = aai.Transcriber()
        config = _build_primary_config()
        transcript = transcriber.transcribe(audio_path, config=config)

        # Check for errors
        if transcript.status == aai.TranscriptStatus.error:
            primary_error = str(transcript.error or "unknown error")
            logger.warning(
                "AssemblyAI primary model request failed, retrying legacy config. error=%s",
                primary_error,
            )
            legacy_config = _build_legacy_config()
            transcript = transcriber.transcribe(audio_path, config=legacy_config)
            if transcript.status == aai.TranscriptStatus.error:
                legacy_error = str(transcript.error or "unknown error")
                raise RuntimeError(
                    f"AssemblyAI transcription failed (primary={primary_error}; legacy={legacy_error})"
                )

        logger.info("AssemblyAI transcription completed successfully")
        logger.info(
            "Found %s speaker turns",
            len(transcript.utterances) if transcript.utterances else 0,
        )

        # Convert AssemblyAI utterances to TranscriptTurn format
        turns: List[TranscriptTurn] = []

        for utterance in transcript.utterances or []:
            # Map AssemblyAI speaker labels (A, B, C...) to provided names
            speaker_label = utterance.speaker  # e.g., "A", "B", "C"

            if speaker_name_list and speaker_label:
                try:
                    speaker_idx = ord(speaker_label) - ord("A")
                    if 0 <= speaker_idx < len(speaker_name_list):
                        speaker_name = speaker_name_list[speaker_idx]
                    else:
                        speaker_name = f"SPEAKER {speaker_label}"
                except (TypeError, ValueError):
                    speaker_name = f"SPEAKER {speaker_label}"
            else:
                speaker_name = f"SPEAKER {speaker_label}" if speaker_label else "SPEAKER 1"

            # Convert timestamp from milliseconds to [MM:SS] format for consistency
            timestamp_str = None
            if include_timestamps and getattr(utterance, "start", None) is not None:
                start_ms = utterance.start
                start_seconds = start_ms / 1000.0
                minutes = int(start_seconds // 60)
                seconds = int(start_seconds % 60)
                timestamp_str = f"[{minutes:02d}:{seconds:02d}]"

            # Extract word-level timestamps from utterance
            word_timestamps: List[WordTimestamp] = []
            if hasattr(utterance, "words") and utterance.words:
                for word in utterance.words:
                    word_timestamps.append(
                        WordTimestamp(
                            text=word.text,
                            start=float(word.start),
                            end=float(word.end),
                            confidence=float(word.confidence)
                            if hasattr(word, "confidence") and word.confidence is not None
                            else None,
                            speaker=speaker_name,
                        )
                    )

            turns.append(
                TranscriptTurn(
                    speaker=speaker_name,
                    text=utterance.text,
                    timestamp=timestamp_str,
                    words=word_timestamps if word_timestamps else None,
                )
            )

        logger.info("Converted %s utterances to TranscriptTurn format", len(turns))
        # Mark continuation turns (same speaker as previous)
        turns = mark_continuation_turns(turns)
        return turns

    except Exception as e:
        logger.error("AssemblyAI transcription error: %s", str(e))
        import traceback

        logger.error(traceback.format_exc())
        raise RuntimeError(f"AssemblyAI transcription error: {e}") from e


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

def process_transcription(
    file_bytes: Optional[bytes],
    filename: str,
    speaker_names: Optional[List[str]],
    title_data: dict,
    input_path: Optional[str] = None,
):
    with tempfile.TemporaryDirectory() as temp_dir:
        if input_path:
            source_path = input_path
        else:
            if file_bytes is None:
                raise ValueError("file_bytes required when input_path is not provided")
            source_path = os.path.join(temp_dir, filename)
            with open(source_path, "wb") as f:
                f.write(file_bytes)

        ext = filename.split('.')[-1].lower()
        audio_path = None
        if ext in SUPPORTED_VIDEO_TYPES:
            output_audio_filename = f"{os.path.splitext(os.path.basename(filename))[0]}.mp3"
            output_path = os.path.join(temp_dir, output_audio_filename)
            converted_audio_path = convert_video_to_audio(source_path, output_path)
            if converted_audio_path:
                audio_path = converted_audio_path
                ext = "mp3"
            else:
                # Fallback to source media if conversion fails; AssemblyAI accepts many video containers directly.
                logger.warning("Video conversion failed for %s; using source media for transcription", filename)
                audio_path = source_path
        elif ext in SUPPORTED_AUDIO_TYPES:
            audio_path = source_path
        else:
            raise ValueError("Unsupported file type")

        # ------------------------------------------------------------------
        # Retrieve media duration – prefer direct ffprobe for robustness
        # ------------------------------------------------------------------
        duration_seconds = get_media_duration(audio_path)

        if duration_seconds is None:
            # Fallback to pydub if ffprobe failed for some reason
            audio_segment = None
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    audio_segment = AudioSegment.from_file(audio_path)
                    break
                except (PermissionError, FileNotFoundError) as e:
                    if attempt < max_retries - 1:
                        logger.warning("Attempt %d failed to load audio file: %s. Retrying...", attempt + 1, e)
                        time.sleep(1)
                    else:
                        raise e
            if audio_segment is not None:
                duration_seconds = len(audio_segment) / 1000.0
            else:
                duration_seconds = None

        if duration_seconds is None:
            logger.warning("Unable to determine media duration for %s; defaulting to 0s", filename)
            duration_seconds = 0.0

        # ------------------------------------------------------------------
        # Format and store duration for title data
        # ------------------------------------------------------------------
        hours, rem = divmod(duration_seconds, 3600)
        minutes, seconds = divmod(rem, 60)
        file_duration_str = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))
        title_data["FILE_DURATION"] = file_duration_str

        # ------------------------------------------------------------------
        # Proceed with upload & transcription (AssemblyAI only)
        # ------------------------------------------------------------------
        logger.info("Using AssemblyAI transcription engine")

        if not ASSEMBLYAI_AVAILABLE:
            raise RuntimeError("AssemblyAI SDK not installed. Run: pip install assemblyai")

        if not ASSEMBLYAI_API_KEY:
            raise RuntimeError("ASSEMBLYAI_API_KEY environment variable not set")

        turns = transcribe_with_assemblyai(audio_path, speaker_names)

        if not turns:
            raise RuntimeError("AssemblyAI transcription failed: no utterances returned")

        return turns, duration_seconds
