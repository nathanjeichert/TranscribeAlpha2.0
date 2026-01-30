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


# ============================================================================
# Cases System Models
# ============================================================================


class CaseMeta(BaseModel):
    """Case metadata stored in cases/{user_id}/{case_id}/meta.json"""
    case_id: str
    user_id: str
    name: str
    description: Optional[str] = None
    created_at: str  # ISO timestamp
    updated_at: str  # ISO timestamp
    transcript_count: int = 0


class CaseTranscriptEntry(BaseModel):
    """Entry in cases/{user_id}/{case_id}/transcripts.json"""
    media_key: str
    added_at: str  # ISO timestamp
    title_label: Optional[str] = None


class CaseIndex(BaseModel):
    """User's case index stored in cases/{user_id}/index.json"""
    user_id: str
    cases: List[CaseMeta]
    updated_at: str  # ISO timestamp


class CaseSearchMatch(BaseModel):
    """A single search match within a transcript line."""
    line_id: str
    page: int
    line: int
    text: str
    speaker: str
    match_type: str  # 'text' or 'speaker'


class CaseSearchResult(BaseModel):
    """Search results for a single transcript within a case."""
    media_key: str
    title_label: str
    matches: List[CaseSearchMatch]
