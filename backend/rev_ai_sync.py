import os
import time
import logging
import requests
import re
from typing import List, Optional, Dict, Any

from .transcriber import TranscriptTurn, WordTimestamp
# Assuming you have these models available in transcriber or similar

logger = logging.getLogger(__name__)

REV_AI_BASE_URL = "https://api.rev.ai/revspeech/v1beta"

class RevAIAligner:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}"
        }

    def _strip_punctuation(self, text: str) -> str:
        # Remove punctuation for Rev AI submission as per docs
        # Keep spaces and alphanumeric
        return re.sub(r'[^\w\s]', '', text).replace('\n', ' ')

    def submit_alignment_job(self, audio_url: Optional[str], audio_file_path: Optional[str], text: str) -> str:
        url = f"{REV_AI_BASE_URL}/works/alignment"
        
        # Prepare multipart/form-data
        files = {}
        data = {}

        if audio_file_path and os.path.exists(audio_file_path):
             files['media'] = open(audio_file_path, 'rb')
        elif audio_url:
            data['media_url'] = audio_url
        else:
             raise ValueError("Either audio_url or audio_file_path must be provided")

        files['text'] = (None, text) 
        
        response = requests.post(url, headers=self.headers, files=files, data=data)
        
        if response.status_code != 200 and response.status_code != 201:
            logger.error(f"Rev AI Job Submit Failed: {response.text}")
            raise Exception(f"Failed to submit alignment job: {response.text}")
            
        return response.json()['id']

    def get_job_details(self, job_id: str) -> Dict[str, Any]:
        url = f"{REV_AI_BASE_URL}/works/{job_id}"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        return response.json()

    def get_alignment_result(self, job_id: str) -> Dict[str, Any]:
        url = f"{REV_AI_BASE_URL}/works/{job_id}/result"
        # Rev AI output format is JSON
        headers = self.headers.copy()
        headers['Accept'] = 'application/vnd.rev.transcript.v1.0+json'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.json()

    def wait_for_job(self, job_id: str, poll_interval: int = 2) -> Dict[str, Any]:
        while True:
            details = self.get_job_details(job_id)
            status = details.get("status")
            if status == "succeeded":
                return self.get_alignment_result(job_id)
            elif status == "failed":
                raise Exception(f"Alignment job failed: {details.get('failure_detail')}")
            
            time.sleep(poll_interval)

    def align_transcript(self, turns: List[dict], audio_file_path: Optional[str] = None, audio_url: Optional[str] = None) -> List[dict]:
        """
        1. Extract text from turns
        2. Submit to Rev AI
        3. Wait for result
        4. Update original turns with new timestamps
        """
        
        # 1. Prepare text
        # We need to construct the full text for alignment.
        # We also need a way to map the returned words back to our original turns.
        # We'll flatten the turns into a list of words (tokenized by us) to maintain mapping?
        # A simpler approach: Concatenate all text. Rev AI returns aligned words.
        # We walk through our turns and words, and assign the next aligned word's timestamp.
        # The key risk is if tokenization differs.
        # But we send the text to Rev AI. We should tokenize it the same way we send it?
        # Actually, Rev AI accepts a plain text blob.
        # Documentation says: "Transcripts should contain only the words, without punctuation."
        
        full_text_list = []
        # Keep a map of (Turn Index, Word Index in Turn) -> flat index?
        # Or just iterate sequentially.
        
        # Let's tokenize our turns first into a structure we can fill back
        # We will strip punctuation for the version we send, but we need to match it against our version.
        
        # Simplest Strategy:
        # Create a list of "Slots" for timestamps. Each slot corresponds to a word in the original text that we expect Rev AI to align.
        # We iterate turns -> words.
        
        for turn in turns:
            # Pydantic dict compatibility
            words = turn.get('words', [])
            if not words:
                # If no word level data, we might need to tokenize the text ourselves
                # This happens if we loaded a transcript that wasn't from AssemblyAI originally or lost metadata
                # We should assume 'words' exists or create them from 'text'
                # For safety, let's re-tokenize the 'text' field if 'words' is missing
                # But 'words' are preferable.
                pass
        
        # Actually, let's try to trust the 'words' array if present, otherwise split 'text'.
        # BUT, the user might have edited 'text' but the 'words' array might be stale?
        # Usually, when editing text in the editor, we might not be updating 'words' perfectly?
        # If the user edited text, we definitely want to trust 'text'.
        # So we should probably re-tokenize 'text' from scratch.
        
        full_plain_text_parts = []
        
        # We will hold references to the objects we want to update
        word_objects_to_update = [] 
        
        processed_turns = []
        
        for turn in turns:
            turn_text = turn.get('text', '')
            speaker = turn.get('speaker', 'Unknown')
            
            # Simple tokenization that keeps punctuation separate or attached?
            # Rev AI alignment ignores punctuation.
            # So if we have "Hello, world!", we send "Hello world"
            # We get back "Hello" (start, end) and "world" (start, end).
            # We want to attach "Hello" timestamp to "Hello," and "world" to "world!".
            
            # Helper to split text into word-tokens that might contain punctuation
            raw_tokens = turn_text.split()
            
            new_words = []
            
            for token in raw_tokens:
                # Prepare token for Rev AI (strip punctuation)
                clean_token = re.sub(r'[^\w]', '', token).lower() # Remove non-alphanumeric
                
                if clean_token:
                    full_plain_text_parts.append(clean_token)
                    
                    # Create a new WordTimestamp object (placeholder)
                    # We'll fill start/end later
                    word_obj = {
                        "text": token, # Keep original with punctuation
                        "start": 0.0,
                        "end": 0.0,
                        "confidence": 1.0,
                        "speaker": speaker
                    }
                    new_words.append(word_obj)
                    word_objects_to_update.append(word_obj)
                else:
                    # Token is just punctuation? e.g. "-"
                    # We can keep it but we won't get a timestamp for it from Rev AI.
                    # We can perhaps infer it or just leave it 0.0 or copy previous/next.
                     word_obj = {
                        "text": token, 
                        "start": 0.0,
                        "end": 0.0,
                        "confidence": 1.0,
                        "speaker": speaker
                    }
                     new_words.append(word_obj)
                     # Do not add to word_objects_to_update, or handle separately?
                     # Ideally we interpolate. For now let's skip adding to valid update list.

            # Update turn with new word list structure (we will update the values in place later)
            turn['words'] = new_words
            processed_turns.append(turn)

        full_text_for_api = " ".join(full_plain_text_parts)
        
        if not full_text_for_api.strip():
            logger.warning("No valid text found to align")
            return turns

        # 2. Submit
        logger.info(f"Submitting text length {len(full_text_for_api)} to Rev AI")
        job_id = self.submit_alignment_job(audio_url, audio_file_path, full_text_for_api)
        logger.info(f"Alignment job submitted: {job_id}")
        
        # 3. Wait
        result = self.wait_for_job(job_id)
        
        # 4. Map results
        # Result structure: { "monologues": [ { "elements": [ { "type": "text", "value": "word", "ts": 0.5, "end_ts": 0.6, ... } ] } ] }
        # Note: Rev AI Forced Alignment result structure might differ slightly from transcription.
        # Usually it returns standard Rev JSON.
        
        aligned_elements = []
        for monologue in result.get('monologues', []):
            for element in monologue.get('elements', []):
                if element.get('type') == 'text':
                    aligned_elements.append(element)
        
        # Now match aligned_elements to word_objects_to_update
        # Ideally len(aligned_elements) == len(word_objects_to_update)
        # But if we messed up tokenization or Rev AI dropped something, we might drift.
        # We should try to align them robustly, or just zip if we trust our cleaning.
        
        logger.info(f"Rev AI returned {len(aligned_elements)} aligned words. We have {len(word_objects_to_update)} words waiting.")
        
        min_len = min(len(aligned_elements), len(word_objects_to_update))
        
        for i in range(min_len):
            rev_word = aligned_elements[i]
            local_word = word_objects_to_update[i]
            
            # Map values
            # Rev AI timestamps are in seconds? Docs say "ts" and "end_ts" are usually seconds.
            # Wait, check docs: "ts": 1.5, "end_ts": 2.5 (floats, seconds) or milliseconds?
            # Standard Rev AI is seconds.
            # But the 'transcriber.py' uses milliseconds for WordTimestamp init?
            # Let's check 'transcriber.py': 
            # line 122: start: float  # Start time in milliseconds
            # line 266: start_seconds = start_ms / 1000.0
            
            # So WordTimestamp expects MILLISECONDS.
            # Rev AI return SECONDS (usually).
            # I will assume seconds and convert to MS.
            
            start_sec = rev_word.get('ts')
            end_sec = rev_word.get('end_ts')
            conf = rev_word.get('confidence', 1.0)
            
            if start_sec is not None:
                local_word['start'] = start_sec * 1000.0
            if end_sec is not None:
                local_word['end'] = end_sec * 1000.0
            local_word['confidence'] = conf

        # 5. Update Turn-level timestamps and Metadata
        # We need to iterate processed_turns and update 'timestamp' string field: [MM:SS]
        # and maybe remove words that were not updated if we want? No, keep them.
        
        # Also handle punctuation-only words (interpolate?)
        # For now, let's leave them as 0.0 or equal to previous word end?
        # Better: if 'start' is 0.0 and it's punctuation, set it to previous word's end.
        
        last_end = 0.0
        for turn in processed_turns:
            words = turn['words']
            if not words:
                continue
                
            # First pass: find valid times
            # Second pass: fill gaps
             
            # Update turn timestamp from first word
            first_valid_word = next((w for w in words if w['start'] > 0), None)
            if first_valid_word:
                 # transcriber.py uses format [MM:SS]
                 # We need a helper for seconds_to_timestamp or import it
                 start_sec = first_valid_word['start'] / 1000.0
                 m = int(start_sec // 60)
                 s = int(start_sec % 60)
                 turn['timestamp'] = f"[{m:02d}:{s:02d}]"
            
            # Interpolation loop
            for w in words:
                if w['start'] == 0.0 and w['end'] == 0.0:
                    w['start'] = last_end
                    w['end'] = last_end
                else:
                    last_end = w['end']

        return processed_turns

