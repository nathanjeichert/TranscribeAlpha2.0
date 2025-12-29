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

    def align_transcript(self, turns: List[dict], audio_file_path: Optional[str] = None, audio_url: Optional[str] = None) -> List[dict]:
        """
        Align transcript with audio using Rev AI Forced Alignment API.

        Simplified approach:
        1. Build plain text from turns, tracking speaker ownership per word
        2. Upload to GCS and submit to Rev AI
        3. Use Rev AI's output directly (their word values + timestamps)
        4. Rebuild turns from Rev AI's elements with speaker assignments
        5. Return new turns with accurate word-level timestamps
        """

        # Step 1: Build plain text and track speaker boundaries
        # We track which speaker owns each word by index
        plain_text_words = []
        speaker_per_word = []  # speaker_per_word[i] = speaker name for word i

        for turn in turns:
            turn_text = turn.get('text', '')
            speaker = turn.get('speaker', 'UNKNOWN')

            # Split text and strip punctuation for Rev AI
            for token in turn_text.split():
                clean_token = re.sub(r'[^\w]', '', token).lower()
                if clean_token:
                    plain_text_words.append(clean_token)
                    speaker_per_word.append(speaker)

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

            # Step 3: Extract aligned words from Rev AI response
            aligned_words = []
            for monologue in result.get('monologues', []):
                for element in monologue.get('elements', []):
                    if element.get('type') == 'text':
                        aligned_words.append(element)

            logger.info("Rev AI returned %d aligned words (expected %d)", len(aligned_words), len(plain_text_words))

            # Step 4: Build new turns from Rev AI output with speaker assignments
            # Group consecutive words by speaker
            new_turns = []
            current_speaker = None
            current_words = []
            current_text_parts = []

            for i, rev_word in enumerate(aligned_words):
                # Get speaker for this word (fall back to last known if index out of range)
                if i < len(speaker_per_word):
                    word_speaker = speaker_per_word[i]
                else:
                    word_speaker = speaker_per_word[-1] if speaker_per_word else 'UNKNOWN'

                # Get word data from Rev AI
                word_text = rev_word.get('value', '')
                ts = rev_word.get('ts')
                end_ts = rev_word.get('end_ts')
                confidence = rev_word.get('confidence', 1.0)

                # Convert to milliseconds (Rev AI returns seconds)
                # Use interpolation fallback if timestamp is missing
                if ts is not None:
                    word_start_ms = ts * 1000.0
                else:
                    # Fallback: use end of previous word or 0
                    if current_words:
                        word_start_ms = current_words[-1].get('end', 0.0)
                    elif new_turns and new_turns[-1].get('words'):
                        word_start_ms = new_turns[-1]['words'][-1].get('end', 0.0)
                    else:
                        word_start_ms = 0.0

                if end_ts is not None:
                    word_end_ms = end_ts * 1000.0
                else:
                    word_end_ms = word_start_ms  # Zero duration if unknown

                word_obj = {
                    "text": word_text,
                    "start": word_start_ms,
                    "end": word_end_ms,
                    "confidence": confidence,
                    "speaker": word_speaker,
                }

                # Check if speaker changed - flush current turn
                if current_speaker is not None and word_speaker != current_speaker:
                    # Save current turn
                    if current_words:
                        turn_start_sec = current_words[0]['start'] / 1000.0
                        m, s = int(turn_start_sec // 60), int(turn_start_sec % 60)
                        new_turns.append({
                            "speaker": current_speaker,
                            "text": " ".join(current_text_parts),
                            "timestamp": f"[{m:02d}:{s:02d}]",
                            "words": current_words,
                        })
                    current_words = []
                    current_text_parts = []

                current_speaker = word_speaker
                current_words.append(word_obj)
                current_text_parts.append(word_text)

            # Flush final turn
            if current_words:
                turn_start_sec = current_words[0]['start'] / 1000.0
                m, s = int(turn_start_sec // 60), int(turn_start_sec % 60)
                new_turns.append({
                    "speaker": current_speaker,
                    "text": " ".join(current_text_parts),
                    "timestamp": f"[{m:02d}:{s:02d}]",
                    "words": current_words,
                })

            logger.info("Built %d new turns from Rev AI alignment", len(new_turns))
            if new_turns and new_turns[0].get('words'):
                logger.info("Sample first word: %s", new_turns[0]['words'][0])

            return new_turns

        finally:
            # Cleanup temporary GCS blobs
            for blob_name in temp_blobs:
                self._cleanup_gcs_blob(blob_name)
