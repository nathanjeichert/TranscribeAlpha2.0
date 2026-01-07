from typing import List, Optional
from pydantic import BaseModel


class WordTimestamp(BaseModel):
    """Represents a single word with precise timing information."""
    text: str
    start: float  # Start time in milliseconds
    end: float    # End time in milliseconds
    confidence: Optional[float] = None
    speaker: Optional[str] = None


class TranscriptTurn(BaseModel):
    speaker: str
    text: str
    timestamp: Optional[str] = None
    words: Optional[List[WordTimestamp]] = None  # Word-level timestamps for accurate line timing
    is_continuation: bool = False  # True if same speaker as previous turn (no speaker label needed)


class GeminiWordTiming(BaseModel):
    """Word-level timing from Gemini transcription."""
    word: str
    start: float
    end: float


class GeminiUtterance(BaseModel):
    """A single speaker utterance from Gemini transcription."""
    speaker: str
    text: str
    start: float
    end: float
    words: List[GeminiWordTiming]
