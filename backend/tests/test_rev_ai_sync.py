import unittest
from unittest.mock import patch

from backend.rev_ai_sync import RevAIAligner


class _FakeResponse:
    def __init__(self, status_code=201, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {"id": "job-123"}
        self.text = text

    def json(self):
        return self._payload


class RevAIAlignerPayloadTests(unittest.TestCase):
    @patch("backend.rev_ai_sync.requests.post")
    def test_submit_alignment_job_uses_top_level_transcript_text(self, mock_post):
        mock_post.return_value = _FakeResponse()
        aligner = RevAIAligner(api_key="test-key")

        job_id = aligner.submit_alignment_job(
            audio_url="https://example.com/audio.wav",
            transcript_text="hello world",
        )

        self.assertEqual(job_id, "job-123")
        _, kwargs = mock_post.call_args
        payload = kwargs["json"]
        self.assertEqual(payload["source_config"]["url"], "https://example.com/audio.wav")
        self.assertEqual(payload["transcript_text"], "hello world")
        self.assertNotIn("source_transcript_config", payload)


if __name__ == "__main__":
    unittest.main()
