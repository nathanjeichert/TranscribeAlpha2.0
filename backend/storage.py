import os
import tempfile
from typing import Tuple


async def save_upload_to_tempfile(upload) -> Tuple[str, int]:
    """Stream an UploadFile to disk and return ``(path, size)``."""
    suffix = os.path.splitext(upload.filename or "")[1]
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    size = 0
    try:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            temp_file.write(chunk)
    finally:
        temp_file.close()

    try:
        await upload.seek(0)
    except Exception:
        pass

    return temp_file.name, size
