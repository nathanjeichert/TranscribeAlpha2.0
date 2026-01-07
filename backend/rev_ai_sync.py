import copy
import os
import time
import logging
import requests
import re
import tempfile
from datetime import timedelta
from typing import List, Optional, Dict, Any, Tuple
from difflib import SequenceMatcher

from google.cloud import storage
from google import auth
from google.auth.transport import requests as google_requests
from google.auth import compute_engine
from google.auth.compute_engine import credentials as compute_credentials

# Import models with fallback pattern
try:
    from .models import TranscriptTurn, WordTimestamp
except ImportError:
    try:
        from models import TranscriptTurn, WordTimestamp
    except ImportError:
        import models
        TranscriptTurn = models.TranscriptTurn
        WordTimestamp = models.WordTimestamp

logger = logging.getLogger(__name__)

# Rev AI Alignment API (separate from speech-to-text API)
REV_AI_ALIGNMENT_BASE_URL = "https://api.rev.ai/alignment/v1"

# Cloud Storage bucket for temporary files
BUCKET_NAME = "transcribealpha-uploads-1750110926"

ALIGNMENT_SPLIT_RE = re.compile(r"[-–—/\\\\]")
ALIGNMENT_CLEAN_RE = re.compile(r"[^\w]+", re.UNICODE)


def normalize_alignment_token(token: str) -> List[str]:
    if not token:
        return []
    normalized = token.replace("’", "'").replace("‘", "'")
    normalized = normalized.replace("“", "\"").replace("”", "\"")
    normalized = ALIGNMENT_SPLIT_RE.sub(" ", normalized)
    parts = []
    for part in normalized.split():
        cleaned = ALIGNMENT_CLEAN_RE.sub("", part).lower().strip("_")
        if cleaned:
            parts.append(cleaned)
    return parts


class RevAIAligner:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        self.storage_client = storage.Client()

        # Get credentials for signing URLs on Cloud Run
        self._signing_credentials = None
        self._service_account_email = None
        self._init_signing_credentials()

    def _init_signing_credentials(self):
        """Initialize credentials for signing URLs using IAM signBlob API."""
        try:
            # Get default credentials
            credentials, project = auth.default()

            # Refresh credentials to ensure token is valid
            auth_req = google_requests.Request()
            credentials.refresh(auth_req)

            # On Cloud Run, we need to get the service account email from metadata server
            # The credentials.service_account_email may just return "default"
            try:
                import urllib.request
                metadata_url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
                req = urllib.request.Request(metadata_url, headers={"Metadata-Flavor": "Google"})
                with urllib.request.urlopen(req, timeout=5) as response:
                    self._service_account_email = response.read().decode('utf-8').strip()
                logger.info("Got service account email from metadata: %s", self._service_account_email)
            except Exception as meta_err:
                logger.warning("Could not get SA email from metadata: %s", meta_err)
                # Fallback to credentials attribute
                if hasattr(credentials, 'service_account_email'):
                    self._service_account_email = credentials.service_account_email

            self._signing_credentials = credentials
            logger.info("Initialized signing credentials for: %s", self._service_account_email)
        except Exception as e:
            logger.warning("Could not initialize signing credentials: %s", e)

    def _create_signed_url(self, blob_name: str, expiration_minutes: int = 15) -> str:
        """Create a signed URL for a Cloud Storage blob using IAM signBlob API."""
        bucket = self.storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)

        # Use IAM-based signing which works with Compute Engine credentials
        if self._service_account_email:
            url = blob.generate_signed_url(
                version="v4",
                expiration=timedelta(minutes=expiration_minutes),
                method="GET",
                service_account_email=self._service_account_email,
                access_token=self._signing_credentials.token,
            )
        else:
            # Fallback - try regular signing (works if running with service account key)
            url = blob.generate_signed_url(
                version="v4",
                expiration=timedelta(minutes=expiration_minutes),
                method="GET"
            )

        logger.info("Generated signed URL for %s (expires in %d min)", blob_name, expiration_minutes)
        return url

    def _upload_text_to_gcs(self, text: str, filename: str) -> str:
        """Upload transcript text to Cloud Storage and return blob name."""
        bucket = self.storage_client.bucket(BUCKET_NAME)
        blob_name = f"rev_ai_temp/{filename}"
        blob = bucket.blob(blob_name)

        blob.upload_from_string(text, content_type="text/plain")
        logger.info("Uploaded transcript to GCS: %s", blob_name)

        return blob_name

    def _upload_audio_to_gcs(self, audio_path: str) -> str:
        """Upload audio file to Cloud Storage and return blob name."""
        bucket = self.storage_client.bucket(BUCKET_NAME)
        filename = os.path.basename(audio_path)
        blob_name = f"rev_ai_temp/{int(time.time())}_{filename}"
        blob = bucket.blob(blob_name)

        blob.upload_from_filename(audio_path)
        logger.info("Uploaded audio to GCS: %s", blob_name)

        return blob_name

    def _cleanup_gcs_blob(self, blob_name: str):
        """Delete a temporary blob from Cloud Storage."""
        try:
            bucket = self.storage_client.bucket(BUCKET_NAME)
            blob = bucket.blob(blob_name)
            blob.delete()
            logger.info("Cleaned up GCS blob: %s", blob_name)
        except Exception as e:
            logger.warning("Failed to cleanup GCS blob %s: %s", blob_name, e)

    def submit_alignment_job(self, audio_url: str, transcript_url: str, metadata: str = "") -> str:
        """Submit alignment job to Rev AI using URLs."""
        url = f"{REV_AI_ALIGNMENT_BASE_URL}/jobs"

        payload = {
            "source_config": {
                "url": audio_url
            },
            "source_transcript_config": {
                "url": transcript_url
            }
        }

        if metadata:
            payload["metadata"] = metadata

        logger.info("Submitting alignment job to Rev AI: %s", url)
        logger.info("Audio URL: %s...", audio_url[:100])
        logger.info("Transcript URL: %s...", transcript_url[:100])

        response = requests.post(url, headers=self.headers, json=payload)

        logger.info("Rev AI response status: %s", response.status_code)
        logger.info("Rev AI response body: %s", response.text[:500] if response.text else 'empty')

        if response.status_code not in (200, 201):
            logger.error("Rev AI Job Submit Failed (HTTP %s): %s", response.status_code, response.text)
            raise Exception(f"Failed to submit alignment job (HTTP {response.status_code}): {response.text}")

        return response.json()['id']

    def get_job_details(self, job_id: str) -> Dict[str, Any]:
        """Get job status from Rev AI."""
        url = f"{REV_AI_ALIGNMENT_BASE_URL}/jobs/{job_id}"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        return response.json()

    def get_alignment_result(self, job_id: str) -> Dict[str, Any]:
        """Get alignment results from Rev AI."""
        url = f"{REV_AI_ALIGNMENT_BASE_URL}/jobs/{job_id}/transcript"
        headers = self.headers.copy()
        headers['Accept'] = 'application/vnd.rev.transcript.v1.0+json'

        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.json()

    def wait_for_job(self, job_id: str, poll_interval: int = 3, max_wait: int = 600) -> Dict[str, Any]:
        """Poll for job completion."""
        start_time = time.time()

        while time.time() - start_time < max_wait:
            details = self.get_job_details(job_id)
            status = details.get("status")

            logger.info("Rev AI job %s status: %s", job_id, status)

            if status == "completed":
                return self.get_alignment_result(job_id)
            elif status == "failed":
                failure = details.get('failure', 'Unknown error')
                failure_detail = details.get('failure_detail', '')
                raise Exception(f"Alignment job failed: {failure} - {failure_detail}")

            time.sleep(poll_interval)

        raise Exception(f"Alignment job timed out after {max_wait} seconds")

    def align_transcript(
        self,
        turns: List[dict],
        audio_file_path: Optional[str] = None,
        audio_url: Optional[str] = None,
        source_turns: Optional[List[dict]] = None,
    ) -> List[dict]:
        """
        Align transcript with audio using Rev AI Forced Alignment API.

        Timestamp-only approach (preserves original text):
        1. Build plain text from turns for Rev AI alignment
        2. Also build a flat list of original words (with punctuation intact)
        3. Submit to Rev AI and get word-level timestamps
        4. Map Rev AI timestamps back to original words by position
        5. Update original turns with new timestamps, keeping original text
        """

        # Step 1: Build plain text for Rev AI AND track original words
        plain_text_words = []  # Cleaned words for Rev AI
        clean_word_to_original_idx = []
        original_words = []    # Original words with punctuation, indexed globally
        word_to_turn_idx = []  # Maps global word index to (turn_index, word_index_in_turn)
        turn_word_positions = [0] * len(turns)

        for turn_idx, turn in enumerate(turns):
            turn_text = turn.get('text', '')

            for token in turn_text.split():
                clean_parts = normalize_alignment_token(token)
                if not clean_parts:
                    continue
                original_idx = len(original_words)
                original_words.append(token)  # Keep original with punctuation
                word_to_turn_idx.append((turn_idx, turn_word_positions[turn_idx]))
                turn_word_positions[turn_idx] += 1

                for clean_part in clean_parts:
                    plain_text_words.append(clean_part)
                    clean_word_to_original_idx.append(original_idx)

        full_text_for_api = " ".join(plain_text_words)

        if not full_text_for_api.strip():
            logger.warning("No valid text found to align")
            return turns

        logger.info("Prepared %d words for alignment from %d turns", len(plain_text_words), len(turns))

        # Track blobs for cleanup
        temp_blobs = []

        try:
            # Step 2: Upload transcript text to GCS
            transcript_blob_name = self._upload_text_to_gcs(
                full_text_for_api,
                f"transcript_{int(time.time())}.txt"
            )
            temp_blobs.append(transcript_blob_name)
            transcript_url = self._create_signed_url(transcript_blob_name)

            # Handle audio - either use existing URL or upload file
            if audio_url:
                final_audio_url = audio_url
            elif audio_file_path and os.path.exists(audio_file_path):
                audio_blob_name = self._upload_audio_to_gcs(audio_file_path)
                temp_blobs.append(audio_blob_name)
                final_audio_url = self._create_signed_url(audio_blob_name)
            else:
                raise ValueError("Either audio_url or audio_file_path must be provided")

            # Submit job
            logger.info("Submitting alignment job with %d words", len(plain_text_words))
            job_id = self.submit_alignment_job(final_audio_url, transcript_url)
            logger.info("Alignment job submitted: %s", job_id)

            # Wait for result
            result = self.wait_for_job(job_id)

            # Step 3: Extract aligned words and timestamps from Rev AI response
            aligned_tokens = []
            timestamps = []
            last_end_ms = 0.0
            for monologue in result.get('monologues', []):
                for element in monologue.get('elements', []):
                    if element.get('type') != 'text':
                        continue
                    value = element.get('value') or element.get('text') or ''
                    token_parts = normalize_alignment_token(value)
                    if not token_parts:
                        continue

                    ts = element.get('ts')
                    end_ts = element.get('end_ts')
                    confidence = element.get('confidence', 1.0)

                    if ts is not None:
                        start_ms = ts * 1000.0
                    else:
                        start_ms = last_end_ms  # Fallback to end of previous word

                    if end_ts is not None:
                        end_ms = end_ts * 1000.0
                    else:
                        end_ms = start_ms  # Zero duration if unknown

                    for token in token_parts:
                        aligned_tokens.append(token)
                        timestamps.append({
                            'start': start_ms,
                            'end': end_ms,
                            'confidence': confidence,
                        })
                    last_end_ms = end_ms

            logger.info("Rev AI returned %d aligned words (expected %d)", len(aligned_tokens), len(plain_text_words))

            matcher = SequenceMatcher(None, plain_text_words, aligned_tokens, autojunk=False)
            word_matches = {}
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                if tag != "equal":
                    continue
                for offset in range(i2 - i1):
                    word_matches[i1 + offset] = j1 + offset

            logger.info("Alignment matched %d/%d words", len(word_matches), len(plain_text_words))

            # Step 4.5: Build source (ASR/Gemini) timestamp map for fallback
            source_word_timestamps = {}
            if source_turns:
                source_words = []
                source_clean_tokens = []
                source_clean_to_word_idx = []
                for turn in source_turns:
                    for word in turn.get('words') or []:
                        word_text = str(word.get('text', '')).strip()
                        if not word_text:
                            continue
                        try:
                            start_ms = float(word.get('start', 0.0))
                            end_ms = float(word.get('end', start_ms))
                        except (TypeError, ValueError):
                            continue
                        source_words.append({
                            'text': word_text,
                            'start': start_ms,
                            'end': end_ms,
                            'confidence': word.get('confidence'),
                        })
                        source_idx = len(source_words) - 1
                        for part in normalize_alignment_token(word_text):
                            source_clean_tokens.append(part)
                            source_clean_to_word_idx.append(source_idx)

                if source_clean_tokens and plain_text_words:
                    source_matcher = SequenceMatcher(None, plain_text_words, source_clean_tokens, autojunk=False)
                    for tag, i1, i2, j1, j2 in source_matcher.get_opcodes():
                        if tag != "equal":
                            continue
                        for offset in range(i2 - i1):
                            current_clean_idx = i1 + offset
                            source_clean_idx = j1 + offset
                            if current_clean_idx >= len(clean_word_to_original_idx) or source_clean_idx >= len(source_clean_to_word_idx):
                                continue
                            original_idx = clean_word_to_original_idx[current_clean_idx]
                            source_word_idx = source_clean_to_word_idx[source_clean_idx]
                            source_word_timestamps.setdefault(original_idx, []).append(source_words[source_word_idx])

            # Step 5: Update original turns with new timestamps
            # Deep copy turns to avoid mutating input
            updated_turns = copy.deepcopy(turns)

            original_word_timestamps = {}
            for clean_idx, aligned_idx in word_matches.items():
                if clean_idx >= len(clean_word_to_original_idx) or aligned_idx >= len(timestamps):
                    continue
                original_idx = clean_word_to_original_idx[clean_idx]
                original_word_timestamps.setdefault(original_idx, []).append(timestamps[aligned_idx])

            rev_word_ranges = {}
            rev_word_confidence = {}
            for original_idx, ts_list in original_word_timestamps.items():
                start_ms = min(ts['start'] for ts in ts_list)
                end_ms = max(ts['end'] for ts in ts_list)
                confidence_values = [ts.get('confidence') for ts in ts_list if ts.get('confidence') is not None]
                confidence = min(confidence_values) if confidence_values else 1.0
                rev_word_ranges[original_idx] = (start_ms, end_ms)
                rev_word_confidence[original_idx] = confidence

            def find_adjacent_rev(idx: int, max_distance: int) -> Tuple[Optional[int], Optional[int]]:
                prev_idx = None
                next_idx = None
                for offset in range(1, max_distance + 1):
                    candidate = idx - offset
                    if candidate >= 0 and candidate in rev_word_ranges:
                        prev_idx = candidate
                        break
                for offset in range(1, max_distance + 1):
                    candidate = idx + offset
                    if candidate < len(original_words) and candidate in rev_word_ranges:
                        next_idx = candidate
                        break
                return prev_idx, next_idx

            turn_word_data = {i: [] for i in range(len(turns))}
            timed_originals = 0
            filled_adjacent = 0
            filled_source = 0
            filled_wide = 0
            missing_words = 0

            for original_idx, (turn_idx, _) in enumerate(word_to_turn_idx):
                original_word = original_words[original_idx]
                start_ms = None
                end_ms = None
                confidence = None

                if original_idx in rev_word_ranges:
                    start_ms, end_ms = rev_word_ranges[original_idx]
                    confidence = rev_word_confidence.get(original_idx)
                else:
                    prev_idx, next_idx = find_adjacent_rev(original_idx, 1)
                    if prev_idx is not None and next_idx is not None:
                        prev_end = rev_word_ranges[prev_idx][1]
                        next_start = rev_word_ranges[next_idx][0]
                        gap_ms = next_start - prev_end
                        if 0 <= gap_ms <= 3000:
                            midpoint = prev_end + gap_ms / 2.0
                            start_ms = midpoint
                            end_ms = midpoint
                            filled_adjacent += 1

                if start_ms is None:
                    ts_list = source_word_timestamps.get(original_idx)
                    if ts_list:
                        start_ms = min(ts['start'] for ts in ts_list)
                        end_ms = max(ts['end'] for ts in ts_list)
                        confidence_values = [ts.get('confidence') for ts in ts_list if ts.get('confidence') is not None]
                        confidence = min(confidence_values) if confidence_values else None
                        filled_source += 1

                if start_ms is None:
                    prev_idx, next_idx = find_adjacent_rev(original_idx, 3)
                    if prev_idx is not None and next_idx is not None:
                        prev_end = rev_word_ranges[prev_idx][1]
                        next_start = rev_word_ranges[next_idx][0]
                        gap_ms = next_start - prev_end
                        if 0 <= gap_ms <= 5500:
                            midpoint = prev_end + gap_ms / 2.0
                            start_ms = midpoint
                            end_ms = midpoint
                            filled_wide += 1

                if start_ms is None or end_ms is None:
                    start_ms = -1.0
                    end_ms = -1.0
                    missing_words += 1

                if start_ms >= 0 and end_ms >= 0:
                    timed_originals += 1

                turn_word_data[turn_idx].append({
                    'text': original_word,
                    'start': start_ms,
                    'end': end_ms,
                    'confidence': confidence,
                    'speaker': turns[turn_idx].get('speaker', 'UNKNOWN'),
                })

            logger.info(
                "Alignment timed %d/%d words (adjacent=%d, source=%d, widened=%d, missing=%d)",
                timed_originals,
                len(original_words),
                filled_adjacent,
                filled_source,
                filled_wide,
                missing_words,
            )

            # Update each turn with new word data and recalculate timestamp
            for turn_idx, turn in enumerate(updated_turns):
                words = turn_word_data.get(turn_idx, [])
                turn['words'] = words

                valid_words = [word for word in words if word.get('start', -1) >= 0 and word.get('end', -1) >= 0]
                if valid_words:
                    turn_start_sec = valid_words[0]['start'] / 1000.0
                    m, s = int(turn_start_sec // 60), int(turn_start_sec % 60)
                    turn['timestamp'] = f"[{m:02d}:{s:02d}]"

            logger.info("Updated %d turns with Rev AI timestamps (text preserved)", len(updated_turns))
            if updated_turns and updated_turns[0].get('words'):
                first_word = updated_turns[0]['words'][0]
                logger.info("Sample first word: text='%s', start=%.1f ms", first_word.get('text'), first_word.get('start'))

            return updated_turns

        finally:
            # Cleanup temporary GCS blobs
            for blob_name in temp_blobs:
                self._cleanup_gcs_blob(blob_name)
