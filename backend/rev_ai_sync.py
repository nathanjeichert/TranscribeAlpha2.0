import os
import time
import logging
import requests
import re
import tempfile
from datetime import timedelta
from typing import List, Optional, Dict, Any

from google.cloud import storage
from google import auth
from google.auth.transport import requests as google_requests
from google.auth import compute_engine
from google.auth.compute_engine import credentials as compute_credentials

# Import transcriber models with fallback pattern
try:
    from .transcriber import TranscriptTurn, WordTimestamp
except ImportError:
    try:
        from transcriber import TranscriptTurn, WordTimestamp
    except ImportError:
        import transcriber
        TranscriptTurn = transcriber.TranscriptTurn
        WordTimestamp = transcriber.WordTimestamp

logger = logging.getLogger(__name__)

# Rev AI Alignment API (separate from speech-to-text API)
REV_AI_ALIGNMENT_BASE_URL = "https://api.rev.ai/alignment/v1"

# Cloud Storage bucket for temporary files
BUCKET_NAME = "transcribealpha-uploads-1750110926"


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

            # On Cloud Run, credentials are Compute Engine credentials
            # We need to get the service account email and use IAM signing
            if hasattr(credentials, 'service_account_email'):
                self._service_account_email = credentials.service_account_email
            else:
                # Try to get from metadata server
                import google.auth.transport.requests
                auth_req = google.auth.transport.requests.Request()
                credentials.refresh(auth_req)
                if hasattr(credentials, 'service_account_email'):
                    self._service_account_email = credentials.service_account_email

            self._signing_credentials = credentials
            logger.info(f"Initialized signing credentials for: {self._service_account_email}")
        except Exception as e:
            logger.warning(f"Could not initialize signing credentials: {e}")

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

        logger.info(f"Generated signed URL for {blob_name} (expires in {expiration_minutes} min)")
        return url

    def _upload_text_to_gcs(self, text: str, filename: str) -> str:
        """Upload transcript text to Cloud Storage and return blob name."""
        bucket = self.storage_client.bucket(BUCKET_NAME)
        blob_name = f"rev_ai_temp/{filename}"
        blob = bucket.blob(blob_name)

        blob.upload_from_string(text, content_type="text/plain")
        logger.info(f"Uploaded transcript to GCS: {blob_name}")

        return blob_name

    def _upload_audio_to_gcs(self, audio_path: str) -> str:
        """Upload audio file to Cloud Storage and return blob name."""
        bucket = self.storage_client.bucket(BUCKET_NAME)
        filename = os.path.basename(audio_path)
        blob_name = f"rev_ai_temp/{int(time.time())}_{filename}"
        blob = bucket.blob(blob_name)

        blob.upload_from_filename(audio_path)
        logger.info(f"Uploaded audio to GCS: {blob_name}")

        return blob_name

    def _cleanup_gcs_blob(self, blob_name: str):
        """Delete a temporary blob from Cloud Storage."""
        try:
            bucket = self.storage_client.bucket(BUCKET_NAME)
            blob = bucket.blob(blob_name)
            blob.delete()
            logger.info(f"Cleaned up GCS blob: {blob_name}")
        except Exception as e:
            logger.warning(f"Failed to cleanup GCS blob {blob_name}: {e}")

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

        logger.info(f"Submitting alignment job to Rev AI: {url}")
        logger.info(f"Audio URL: {audio_url[:100]}...")
        logger.info(f"Transcript URL: {transcript_url[:100]}...")

        response = requests.post(url, headers=self.headers, json=payload)

        logger.info(f"Rev AI response status: {response.status_code}")
        logger.info(f"Rev AI response body: {response.text[:500] if response.text else 'empty'}")

        if response.status_code not in (200, 201):
            logger.error(f"Rev AI Job Submit Failed (HTTP {response.status_code}): {response.text}")
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

            logger.info(f"Rev AI job {job_id} status: {status}")

            if status == "transcribed":
                return self.get_alignment_result(job_id)
            elif status == "failed":
                failure = details.get('failure', 'Unknown error')
                failure_detail = details.get('failure_detail', '')
                raise Exception(f"Alignment job failed: {failure} - {failure_detail}")

            time.sleep(poll_interval)

        raise Exception(f"Alignment job timed out after {max_wait} seconds")

    def align_transcript(self, turns: List[dict], audio_file_path: Optional[str] = None, audio_url: Optional[str] = None) -> List[dict]:
        """
        Align transcript with audio using Rev AI Forced Alignment API.

        1. Prepare plain text from turns
        2. Upload audio and transcript to GCS
        3. Create signed URLs
        4. Submit to Rev AI
        5. Wait for result
        6. Update turns with new timestamps
        7. Cleanup temporary files
        """

        # Build plain text and word mapping
        full_plain_text_parts = []
        word_objects_to_update = []
        processed_turns = []

        for turn in turns:
            turn_text = turn.get('text', '')
            speaker = turn.get('speaker', 'Unknown')

            raw_tokens = turn_text.split()
            new_words = []

            for token in raw_tokens:
                # Strip punctuation for Rev AI (they want only words)
                clean_token = re.sub(r'[^\w]', '', token).lower()

                if clean_token:
                    full_plain_text_parts.append(clean_token)

                    word_obj = {
                        "text": token,
                        "start": 0.0,
                        "end": 0.0,
                        "confidence": 1.0,
                        "speaker": speaker
                    }
                    new_words.append(word_obj)
                    word_objects_to_update.append(word_obj)
                else:
                    # Punctuation-only token
                    word_obj = {
                        "text": token,
                        "start": 0.0,
                        "end": 0.0,
                        "confidence": 1.0,
                        "speaker": speaker
                    }
                    new_words.append(word_obj)

            turn['words'] = new_words
            processed_turns.append(turn)

        full_text_for_api = " ".join(full_plain_text_parts)

        if not full_text_for_api.strip():
            logger.warning("No valid text found to align")
            return turns

        logger.info(f"Prepared {len(full_plain_text_parts)} words for alignment")

        # Track blobs for cleanup
        temp_blobs = []

        try:
            # Upload transcript text to GCS
            transcript_blob_name = self._upload_text_to_gcs(
                full_text_for_api,
                f"transcript_{int(time.time())}.txt"
            )
            temp_blobs.append(transcript_blob_name)
            transcript_url = self._create_signed_url(transcript_blob_name)

            # Handle audio - either use existing URL or upload file
            if audio_url:
                # If we already have a URL, use it
                final_audio_url = audio_url
            elif audio_file_path and os.path.exists(audio_file_path):
                # Upload audio to GCS
                audio_blob_name = self._upload_audio_to_gcs(audio_file_path)
                temp_blobs.append(audio_blob_name)
                final_audio_url = self._create_signed_url(audio_blob_name)
            else:
                raise ValueError("Either audio_url or audio_file_path must be provided")

            # Submit job
            logger.info(f"Submitting alignment job with {len(full_text_for_api)} chars of text")
            job_id = self.submit_alignment_job(final_audio_url, transcript_url)
            logger.info(f"Alignment job submitted: {job_id}")

            # Wait for result
            result = self.wait_for_job(job_id)

            # Parse results - Rev AI returns monologues with elements
            aligned_elements = []
            for monologue in result.get('monologues', []):
                for element in monologue.get('elements', []):
                    if element.get('type') == 'text':
                        aligned_elements.append(element)

            logger.info(f"Rev AI returned {len(aligned_elements)} aligned words. We have {len(word_objects_to_update)} words.")

            # Map timestamps back to our words
            min_len = min(len(aligned_elements), len(word_objects_to_update))

            for i in range(min_len):
                rev_word = aligned_elements[i]
                local_word = word_objects_to_update[i]

                # Rev AI returns timestamps in seconds, we store in milliseconds
                start_sec = rev_word.get('ts')
                end_sec = rev_word.get('end_ts')
                conf = rev_word.get('confidence', 1.0)

                if start_sec is not None:
                    local_word['start'] = start_sec * 1000.0
                if end_sec is not None:
                    local_word['end'] = end_sec * 1000.0
                local_word['confidence'] = conf

            # Update turn-level timestamps and interpolate missing values
            last_end = 0.0
            for turn in processed_turns:
                words = turn['words']
                if not words:
                    continue

                # Set turn timestamp from first valid word
                first_valid_word = next((w for w in words if w['start'] > 0), None)
                if first_valid_word:
                    start_sec = first_valid_word['start'] / 1000.0
                    m = int(start_sec // 60)
                    s = int(start_sec % 60)
                    turn['timestamp'] = f"[{m:02d}:{s:02d}]"

                # Interpolate timestamps for punctuation-only words
                for w in words:
                    if w['start'] == 0.0 and w['end'] == 0.0:
                        w['start'] = last_end
                        w['end'] = last_end
                    else:
                        last_end = w['end']

            return processed_turns

        finally:
            # Cleanup temporary GCS blobs
            for blob_name in temp_blobs:
                self._cleanup_gcs_blob(blob_name)
