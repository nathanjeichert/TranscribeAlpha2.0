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


def create_docx(title_data: dict, transcript_turns: List[TranscriptTurn]) -> bytes:
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
            p.paragraph_format.first_line_indent = Inches(1.0)
            p.paragraph_format.line_spacing = 2.0
            p.paragraph_format.space_after = Pt(0)
            
            # Include timestamp if available
            if turn.timestamp:
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
            
            # Include timestamp if available
            if turn.timestamp:
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


def process_transcription(file_bytes: bytes, filename: str, speaker_names: Optional[List[str]], title_data: dict, include_timestamps: bool = False, ai_model: str = "flash"):
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
        gemini_file = upload_to_gemini(audio_path)
        if not gemini_file:
            raise RuntimeError("Failed to upload file to Gemini")
        turns = generate_transcript(gemini_file, speaker_names, include_timestamps, ai_model)
        client.files.delete(name=gemini_file.name)
        if not turns:
            raise RuntimeError("Failed to generate transcript")
        docx_bytes = create_docx(title_data, turns)
        return turns, docx_bytes
