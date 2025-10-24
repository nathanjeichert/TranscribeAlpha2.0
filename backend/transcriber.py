import os
import io
import json
import time
import tempfile
import logging
import shutil
from typing import List, Optional

from google import genai
from google.genai import types
from google.api_core import exceptions as google_exceptions
from docx import Document
from docx.shared import Inches, Pt
import ffmpeg
from pydub import AudioSegment
from pydub.utils import which
from pydantic import BaseModel, ValidationError

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
    print(f"Found ffmpeg: {ffmpeg_executable_path}")
    ffprobe_executable_path = get_ffprobe_path(ffmpeg_executable_path)
    if ffprobe_executable_path:
        print(f"Found ffprobe: {ffprobe_executable_path}")
    else:
        print("Warning: ffprobe not found")
    
    # Configure pydub
    AudioSegment.converter = ffmpeg_executable_path
    AudioSegment.ffmpeg = ffmpeg_executable_path
    if ffprobe_executable_path:
        AudioSegment.ffprobe = ffprobe_executable_path
else:
    print("WARNING: Could not find ffmpeg executable!")

# Model configurations
MODELS = {
    "flash": "gemini-2.5-flash-preview-05-20",
    "pro": "gemini-2.5-pro-preview-06-05"
}

def get_model_name(ai_model: str = "flash") -> str:
    """Get the model name based on user selection"""
    return MODELS.get(ai_model, MODELS["flash"])
SUPPORTED_VIDEO_TYPES = ["mp4", "mov", "avi", "mkv"]
SUPPORTED_AUDIO_TYPES = ["mp3", "wav", "m4a", "flac", "ogg", "aac", "aiff"]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    print("WARNING: GEMINI_API_KEY environment variable not set")
    client = None
else:
    client = genai.Client(api_key=API_KEY)

class TranscriptTurn(BaseModel):
    speaker: str
    text: str
    timestamp: Optional[str] = None

def convert_video_to_audio(input_path: str, output_path: str, format: str = "mp3") -> Optional[str]:
    try:
        print(f"Converting {input_path} to {output_path}")
        print(f"Using ffmpeg path: {ffmpeg_executable_path}")
        
        if ffmpeg_executable_path:
            # Use subprocess directly with the known ffmpeg path
            cmd = [
                ffmpeg_executable_path,
                '-i', input_path,
                '-acodec', 'libmp3lame',
                '-y',  # overwrite output file
                output_path
            ]
            print(f"Running command: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                print(f"Successfully converted to {output_path}")
                # Add a small delay to ensure the file is completely written and released
                time.sleep(0.5)
                return output_path
            else:
                print(f"ffmpeg failed with return code {result.returncode}")
                print(f"stderr: {result.stderr}")
                return None
        else:
            # Fallback to ffmpeg-python library
            print("Using ffmpeg-python library as fallback")
            ffmpeg.input(input_path).output(output_path, format=format, acodec='libmp3lame').overwrite_output().run(quiet=True)
            return output_path
    except Exception as e:
        logger.error("Unexpected error in convert_video_to_audio: %s", e)
        print(f"Exception in convert_video_to_audio: {e}")
        return None


def get_audio_mime_type(ext: str) -> Optional[str]:
    mime_map = {
        "mp3": "audio/mp3",
        "wav": "audio/wav",
        "aiff": "audio/aiff",
        "aac": "audio/aac",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }
    return mime_map.get(ext.lower())


def upload_to_gemini(file_path: str) -> Optional[types.File]:
    if not client:
        logger.error("Gemini client not initialized - API key not set")
        return None
    try:
        gemini_file = client.files.upload(file=file_path)
        file_state = "PROCESSING"
        retries = 15
        sleep_time = 8
        max_sleep = 45
        while file_state == "PROCESSING" and retries > 0:
            time.sleep(sleep_time)
            file_info = client.files.get(name=gemini_file.name)
            file_state = file_info.state.name
            retries -= 1
            sleep_time = min(sleep_time * 1.5, max_sleep)
        if file_state != "ACTIVE":
            try:
                client.files.delete(name=gemini_file.name)
            except Exception:
                pass
            return None
        return gemini_file
    except Exception as e:
        logger.error("upload failed: %s", e)
        return None


def generate_transcript(gemini_file: types.File, speaker_name_list: Optional[List[str]] = None, include_timestamps: bool = False, ai_model: str = "flash") -> Optional[List[TranscriptTurn]]:
    safety_settings = [
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold=types.HarmBlockThreshold.BLOCK_NONE),
    ]

    if speaker_name_list:
        speaker_prompt_part = f"The speakers are identified as: {', '.join(speaker_name_list)}."
        num_speakers_part = f"There are {len(speaker_name_list)} speakers."
    else:
        speaker_prompt_part = "Speaker identifiers are not provided; use generic identifiers like SPEAKER 1, SPEAKER 2, etc., IN ALL CAPS."
        num_speakers_part = "Determine the number of speakers from the audio."

    if include_timestamps:
        timestamp_prompt_part = "Include precise timestamps in format [MM:SS] for each speaker turn. Each object MUST contain a 'timestamp' field with the start time of that speaker turn."
        required_fields = "BOTH a 'speaker' field, a 'text' field containing ALL consecutive speech from that speaker before the speaker changes, AND a 'timestamp' field"
    else:
        timestamp_prompt_part = ""
        required_fields = "BOTH a 'speaker' field and a 'text' field containing ALL consecutive speech from that speaker before the speaker changes"

    prompt = (
        f"Generate an exact, word-for-word, deposition-style transcript of the speech in this audio file. Pay close attention to the speaker names, the number of speakers, and the changes between speakers. {num_speakers_part} {speaker_prompt_part} "
        f"{timestamp_prompt_part} "
        "Structure the output STRICTLY as a JSON list of objects. "
        f"Each object represents a continuous block of speech from a single speaker and MUST contain {required_fields}."
    )

    contents = [prompt, gemini_file]
    try:
        model_name = get_model_name(ai_model)
        logger.info(f"Using model: {model_name}")
        response = client.models.generate_content(
            model=model_name,
            contents=contents,
            config=types.GenerateContentConfig(
                safety_settings=safety_settings,
                response_mime_type="application/json",
                response_schema=list[TranscriptTurn],
            ),
        )
        transcript_data = json.loads(response.text)
        validated_turns = []
        for turn_data in transcript_data:
            if 'speaker' not in turn_data:
                continue
            if 'text' not in turn_data:
                turn_data['text'] = ""
            # Ensure timestamp field exists if timestamps were requested
            if include_timestamps and 'timestamp' not in turn_data:
                turn_data['timestamp'] = None
            try:
                validated_turns.append(TranscriptTurn(**turn_data))
            except ValidationError:
                continue
        return validated_turns
    except Exception as e:
        logger.error("generate_transcript failed: %s", e)
        return None


def replace_placeholder_text(element, placeholder: str, replacement: str) -> None:
    if hasattr(element, 'paragraphs'):
        for p in element.paragraphs:
            replace_placeholder_text(p, placeholder, replacement)
    if hasattr(element, 'runs'):
        if placeholder in element.text:
            inline = element.runs
            for i in range(len(inline)):
                if placeholder in inline[i].text:
                    text = inline[i].text.replace(placeholder, replacement)
                    inline[i].text = text
    if hasattr(element, 'tables'):
        for table in element.tables:
            for row in table.rows:
                for cell in row.cells:
                    replace_placeholder_text(cell, placeholder, replacement)


def create_docx(title_data: dict, transcript_turns: List[TranscriptTurn], include_timestamps: bool = False) -> bytes:
    """
    Create a DOCX transcript with simple one-paragraph-per-turn formatting.

    Word will automatically wrap lines based on the first-line indent (1.0").
    The XML generation must match Word's natural line wrapping behavior.
    """
    doc = Document("transcript_template.docx")
    for key, value in title_data.items():
        placeholder = f"{{{{{key}}}}}"
        replace_placeholder_text(doc, placeholder, str(value) if value else "")

    body_placeholder = "{{TRANSCRIPT_BODY}}"
    placeholder_paragraph = None
    for p in doc.paragraphs:
        if body_placeholder in p.text:
            placeholder_paragraph = p
            break

    if placeholder_paragraph:
        p_element = placeholder_paragraph._element
        p_element.getparent().remove(p_element)
        for turn in transcript_turns:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.0)
            p.paragraph_format.first_line_indent = Inches(1.0)  # Standard legal transcript indent
            p.paragraph_format.line_spacing = 2.0
            p.paragraph_format.space_after = Pt(0)

            # Include timestamp if available and requested
            if include_timestamps and turn.timestamp:
                timestamp_text = f"{turn.timestamp} "
                timestamp_run = p.add_run(timestamp_text)
                timestamp_run.font.name = "Courier New"

            speaker_run = p.add_run(f"{turn.speaker.upper()}:   ")
            speaker_run.font.name = "Courier New"
            text_run = p.add_run(turn.text)
            text_run.font.name = "Courier New"
    else:
        for turn in transcript_turns:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.0)
            p.paragraph_format.first_line_indent = Inches(1.0)
            p.paragraph_format.line_spacing = 2.0
            p.paragraph_format.space_after = Pt(0)

            # Include timestamp if available and requested
            if include_timestamps and turn.timestamp:
                timestamp_text = f"{turn.timestamp} "
                timestamp_run = p.add_run(timestamp_text)
                timestamp_run.font.name = "Courier New"

            speaker_run = p.add_run(f"{turn.speaker.upper()}:   ")
            speaker_run.font.name = "Courier New"
            text_run = p.add_run(turn.text)
            text_run.font.name = "Courier New"

    buffer = io.BytesIO()
    doc.save(buffer)
    buffer.seek(0)
    return buffer.read()


# Helper to get media duration with ffprobe, avoids pydub's internal lookup issues

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
        print(f"ffprobe duration extraction failed: {e}")
    return None

def srt_to_webvtt(srt_content: str) -> str:
    """Convert SRT content to WebVTT format for HTML5 video"""
    webvtt = "WEBVTT\n\n"
    # Replace comma with period for milliseconds (WebVTT format)
    webvtt += srt_content.replace(',', '.')
    return webvtt

def process_transcription(file_bytes: bytes, filename: str, speaker_names: Optional[List[str]], title_data: dict, include_timestamps: bool = False, ai_model: str = "flash", force_timestamps_for_subtitles: bool = False):
    with tempfile.TemporaryDirectory() as temp_dir:
        input_path = os.path.join(temp_dir, filename)
        with open(input_path, "wb") as f:
            f.write(file_bytes)

        ext = filename.split('.')[-1].lower()
        audio_path = None
        if ext in SUPPORTED_VIDEO_TYPES:
            output_audio_filename = f"{os.path.splitext(filename)[0]}.mp3"
            output_path = os.path.join(temp_dir, output_audio_filename)
            audio_path = convert_video_to_audio(input_path, output_path)
            ext = "mp3"
        elif ext in SUPPORTED_AUDIO_TYPES:
            audio_path = input_path
        else:
            raise ValueError("Unsupported file type")

        mime_type = get_audio_mime_type(ext)

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
                        print(f"Attempt {attempt + 1} failed to load audio file: {e}. Retrying...")
                        time.sleep(1)
                    else:
                        raise e
            if audio_segment is None:
                raise RuntimeError("Failed to load audio file after multiple attempts")

            duration_seconds = len(audio_segment) / 1000.0

        # ------------------------------------------------------------------
        # Format and store duration for title data
        # ------------------------------------------------------------------
        hours, rem = divmod(duration_seconds, 3600)
        minutes, seconds = divmod(rem, 60)
        file_duration_str = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))
        title_data["FILE_DURATION"] = file_duration_str

        # ------------------------------------------------------------------
        # Proceed with upload & transcription
        # ------------------------------------------------------------------
        # Determine if we need timestamps (either requested by user or forced for subtitles)
        need_timestamps = include_timestamps or force_timestamps_for_subtitles
        
        gemini_file = upload_to_gemini(audio_path)
        if not gemini_file:
            raise RuntimeError("Failed to upload file to Gemini")
        turns = generate_transcript(gemini_file, speaker_names, need_timestamps, ai_model)
        client.files.delete(name=gemini_file.name)
        if not turns:
            raise RuntimeError("Failed to generate transcript")
        
        # Create docx with or without timestamps based on user preference
        docx_bytes = create_docx(title_data, turns, include_timestamps)
        
        # Generate subtitles if we have timestamps
        srt_content = None
        webvtt_content = None
        if need_timestamps and turns:
            srt_content = generate_srt_from_transcript(turns)
            webvtt_content = srt_to_webvtt(srt_content)
        
        return turns, docx_bytes, srt_content, webvtt_content, duration_seconds


def format_timestamp_for_srt(timestamp_str: str) -> str:
    """Convert timestamp from [MM:SS] format to SRT format (HH:MM:SS,mmm)"""
    try:
        if not timestamp_str or timestamp_str.strip() == "":
            return "00:00:00,000"
        
        # Remove brackets and strip whitespace
        clean_timestamp = timestamp_str.strip("[]").strip()
        
        # Handle different input formats
        if ":" in clean_timestamp:
            parts = clean_timestamp.split(":")
            if len(parts) == 2:  # MM:SS format
                minutes, seconds = parts
                hours = "00"
            elif len(parts) == 3:  # HH:MM:SS format
                hours, minutes, seconds = parts
            else:
                return "00:00:00,000"
        else:
            # Assume it's just seconds
            total_seconds = float(clean_timestamp)
            hours = int(total_seconds // 3600)
            minutes = int((total_seconds % 3600) // 60)
            seconds = total_seconds % 60
            return f"{hours:02d}:{minutes:02d}:{int(seconds):02d},{int((seconds % 1) * 1000):03d}"
        
        # Convert to proper format
        h = int(hours) if hours.isdigit() else 0
        m = int(minutes) if minutes.isdigit() else 0
        s = float(seconds) if seconds.replace('.', '').isdigit() else 0.0
        
        # Format as HH:MM:SS,mmm
        return f"{h:02d}:{m:02d}:{int(s):02d},{int((s % 1) * 1000):03d}"
    except Exception:
        return "00:00:00,000"


def generate_srt_from_transcript(turns: List[TranscriptTurn]) -> str:
    """Generate SRT subtitle format from transcript turns"""
    srt_content = []
    
    for i, turn in enumerate(turns, 1):
        if not turn.text.strip():
            continue
            
        # Calculate start and end times
        start_time = format_timestamp_for_srt(turn.timestamp) if turn.timestamp else f"00:00:{i*3:02d},000"
        
        # Estimate end time (start of next turn or +3 seconds)
        if i < len(turns) and turns[i].timestamp:
            end_time = format_timestamp_for_srt(turns[i].timestamp)
        else:
            # Add 3 seconds to start time as default duration
            try:
                parts = start_time.split(':')
                h, m, s_ms = int(parts[0]), int(parts[1]), parts[2].split(',')
                s, ms = int(s_ms[0]), int(s_ms[1])
                
                total_ms = (h * 3600 + m * 60 + s) * 1000 + ms + 3000
                
                end_h = total_ms // 3600000
                end_m = (total_ms % 3600000) // 60000
                end_s = (total_ms % 60000) // 1000
                end_ms = total_ms % 1000
                
                end_time = f"{end_h:02d}:{end_m:02d}:{end_s:02d},{end_ms:03d}"
            except:
                end_time = f"00:00:{i*3+3:02d},000"
        
        # Format SRT entry
        srt_entry = f"{i}\n{start_time} --> {end_time}\n{turn.speaker.upper()}: {turn.text}\n"
        srt_content.append(srt_entry)
    
    return "\n".join(srt_content)


def srt_to_webvtt(srt_content: str) -> str:
    """Convert SRT format to WebVTT format for HTML5 video"""
    lines = srt_content.strip().split('\n')
    webvtt_lines = ["WEBVTT", ""]
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        # Skip empty lines
        if not line:
            i += 1
            continue
            
        # Skip subtitle numbers (SRT format)
        if line.isdigit():
            i += 1
            continue
            
        # Process timestamp lines
        if " --> " in line:
            # Convert SRT timestamps to WebVTT (replace comma with period)
            webvtt_timestamp = line.replace(',', '.')
            webvtt_lines.append(webvtt_timestamp)
            i += 1
            
            # Add subtitle text lines
            subtitle_lines = []
            while i < len(lines) and lines[i].strip() and not lines[i].strip().isdigit():
                subtitle_lines.append(lines[i].strip())
                i += 1
            
            webvtt_lines.extend(subtitle_lines)
            webvtt_lines.append("")  # Empty line between subtitles
        else:
            i += 1
    
    return "\n".join(webvtt_lines)


def timestamp_to_seconds(timestamp: Optional[str]) -> float:
    """Convert timestamp like '[MM:SS]' or 'MM:SS' to seconds."""
    if not timestamp:
        return 0.0
    ts = timestamp.strip('[]').strip()
    parts = ts.split(':')
    try:
        if len(parts) == 3:
            h, m, s = map(float, parts)
            return h * 3600 + m * 60 + s
        elif len(parts) == 2:
            m, s = map(float, parts)
            return m * 60 + s
        else:
            return float(ts)
    except ValueError:
        return 0.0


def wrap_text_for_transcript(text: str, max_width: int) -> List[str]:
    """
    Wrap text to fit within max_width characters, preserving word boundaries.

    Args:
        text: The text to wrap
        max_width: Maximum characters per line of text content

    Returns:
        List of wrapped lines
    """
    if not text:
        return [""]

    if max_width <= 0:
        return [text]

    words = text.split()
    lines = []
    current_line = []
    current_length = 0

    for word in words:
        word_length = len(word)
        # +1 for space before word (except first word)
        space_needed = word_length + (1 if current_line else 0)

        if current_length + space_needed <= max_width:
            current_line.append(word)
            current_length += space_needed
        else:
            # Start new line
            if current_line:
                lines.append(" ".join(current_line))
            current_line = [word]
            current_length = word_length

    # Add remaining words
    if current_line:
        lines.append(" ".join(current_line))

    return lines if lines else [""]


def generate_oncue_xml(transcript_turns: List[TranscriptTurn], metadata: dict, audio_duration: float, lines_per_page: int = 25) -> str:
    """
    Generate OnCue-compatible XML from transcript turns.

    This function breaks long utterances into multiple lines to match the DOCX formatting:
    - First line: 15 spaces + "SPEAKER:" (padded to ~21 chars) + text (max ~48 chars)
    - Continuation lines: 5 spaces + text (max ~57 chars)
    - Total line length: ~71 chars for speaker lines, ~62 chars for continuation lines
    """
    from xml.etree.ElementTree import Element, SubElement, tostring

    root = Element(
        "onCue",
        {
            "xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        },
    )

    media_id = os.path.splitext(metadata.get("FILE_NAME", "deposition"))[0]
    depo_attrs = {
        "mediaId": media_id,
        "linesPerPage": str(lines_per_page),
    }
    if metadata.get("DATE"):
        depo_attrs["date"] = metadata["DATE"]

    deposition = SubElement(root, "deposition", depo_attrs)

    video_attrs = {
        "ID": "1",
        "filename": metadata.get("FILE_NAME", "audio.mp3"),
        "startTime": "0",
        "stopTime": str(int(round(audio_duration))),
        "firstPGLN": "101",
        "lastPGLN": "0",  # placeholder
        "startTuned": "no",
        "stopTuned": "no",
    }
    depo_video = SubElement(deposition, "depoVideo", video_attrs)

    # Line formatting constants to match Word's wrapping behavior
    # Word measures: First line = 49 chars content, Continuation = 65 chars content
    # XML must add explicit spaces: 15 for speaker lines, 5 for continuation
    # So XML limits: 49 + 15 + speaker + ":   " for first line, 65 for continuation
    SPEAKER_PREFIX_SPACES = 15  # Leading spaces before speaker name in XML (visual simulation)
    CONTINUATION_SPACES = 5     # Leading spaces for continuation lines in XML (visual simulation)
    SPEAKER_COLON = ":   "      # Colon and spaces after speaker name (total 4 chars)
    MAX_TOTAL_LINE_WIDTH = 72   # Maximum total characters per XML line for speaker lines (49 content + ~23 prefix)
    MAX_CONTINUATION_WIDTH = 62 # Maximum total characters per XML line for continuation lines (57 content + 5 spaces)

    page = 1
    line_in_page = 1
    last_pgln = 101

    for turn_idx, turn in enumerate(transcript_turns):
        # Calculate timestamps
        start_sec = timestamp_to_seconds(turn.timestamp)
        if turn_idx < len(transcript_turns) - 1:
            stop_sec = timestamp_to_seconds(transcript_turns[turn_idx + 1].timestamp)
        else:
            stop_sec = audio_duration

        speaker_name = turn.speaker.upper()
        text = turn.text.strip()

        # Format speaker line: "               SPEAKER:   " + text
        speaker_prefix = " " * SPEAKER_PREFIX_SPACES + speaker_name + SPEAKER_COLON

        # Calculate available space for text on first line
        # Max line width - prefix length = available for text
        max_first_line_text = MAX_TOTAL_LINE_WIDTH - len(speaker_prefix)

        # Wrap text to fit line limits
        wrapped_lines = wrap_text_for_transcript(text, max_first_line_text)

        if not wrapped_lines:
            wrapped_lines = [""]

        # Create first line with speaker
        first_line_text = speaker_prefix + wrapped_lines[0]

        pgln = page * 100 + line_in_page
        last_pgln = pgln

        SubElement(
            depo_video,
            "depoLine",
            {
                "prefix": "",
                "text": first_line_text,
                "page": str(page),
                "line": str(line_in_page),
                "pgLN": str(pgln),
                "videoID": "1",
                "videoStart": f"{start_sec:.2f}",
                "videoStop": f"{stop_sec:.2f}",
                "isEdited": "no",
                "isSynched": "yes",
                "isRedacted": "no",
            },
        )

        # Advance line counter
        line_in_page += 1
        if line_in_page > lines_per_page:
            page += 1
            line_in_page = 1

        # Add continuation lines if text wrapped to multiple lines
        # Continuation lines can use more space since no speaker prefix
        max_continuation_text = MAX_CONTINUATION_WIDTH - CONTINUATION_SPACES

        remaining_text = " ".join(wrapped_lines[1:])
        if remaining_text:
            continuation_wrapped = wrap_text_for_transcript(remaining_text, max_continuation_text)

            for continuation_text in continuation_wrapped:
                # Continuation lines: 5 spaces + text
                continuation_line_text = " " * CONTINUATION_SPACES + continuation_text

                pgln = page * 100 + line_in_page
                last_pgln = pgln

                SubElement(
                    depo_video,
                    "depoLine",
                    {
                        "prefix": "",
                        "text": continuation_line_text,
                        "page": str(page),
                        "line": str(line_in_page),
                        "pgLN": str(pgln),
                        "videoID": "1",
                        "videoStart": f"{start_sec:.2f}",
                        "videoStop": f"{stop_sec:.2f}",
                        "isEdited": "no",
                        "isSynched": "yes",
                        "isRedacted": "no",
                    },
                )

                line_in_page += 1
                if line_in_page > lines_per_page:
                    page += 1
                    line_in_page = 1

    depo_video.set("lastPGLN", str(last_pgln))

    xml_bytes = tostring(root, encoding="utf-8", method="xml")
    xml_str = xml_bytes.decode("utf-8")
    xml_str = "".join(xml_str.splitlines())  # single line like sample
    return xml_str
