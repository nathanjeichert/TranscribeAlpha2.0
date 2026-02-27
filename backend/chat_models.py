"""Pydantic models for the chat and summarize endpoints."""

from typing import Optional

from pydantic import BaseModel


class ChatMessageModel(BaseModel):
    role: str  # 'user' or 'assistant'
    content: str


class ChatFilters(BaseModel):
    evidence_types: Optional[list[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    speakers: Optional[list[str]] = None
    location: Optional[str] = None
    transcript_keys: Optional[list[str]] = None


class ChatRequest(BaseModel):
    messages: list[ChatMessageModel]
    case_id: str
    filters: Optional[ChatFilters] = None
    conversation_id: Optional[str] = None
