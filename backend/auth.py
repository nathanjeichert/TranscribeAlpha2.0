"""
Authentication module for TranscribeAlpha.
Handles JWT token generation, password verification, and Secret Manager integration.
"""

import os
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List

from jose import JWTError, jwt
from passlib.context import CryptContext
from google.cloud import secretmanager
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

logger = logging.getLogger(__name__)

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT configuration
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "dev-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 365  # 1 year - effectively permanent
REFRESH_TOKEN_EXPIRE_DAYS = 3650  # 10 years - effectively permanent

# Secret Manager configuration
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "")
SECRET_NAME = "transcribealpha-users"

# Security scheme
security = HTTPBearer()

# In-memory cache for users (refreshed periodically)
_users_cache: Optional[Dict[str, dict]] = None
_cache_timestamp: Optional[datetime] = None
CACHE_TTL_MINUTES = 5


def get_secret_manager_client():
    """Get Secret Manager client."""
    try:
        return secretmanager.SecretManagerServiceClient()
    except Exception as e:
        logger.error(f"Failed to create Secret Manager client: {e}")
        return None


def load_users_from_secret_manager() -> Dict[str, dict]:
    """
    Load users from Google Secret Manager.
    Returns a dictionary mapping username to user data.
    """
    global _users_cache, _cache_timestamp

    # Check cache first
    if _users_cache and _cache_timestamp:
        if datetime.now(timezone.utc) - _cache_timestamp < timedelta(minutes=CACHE_TTL_MINUTES):
            return _users_cache

    try:
        client = get_secret_manager_client()
        if not client:
            logger.warning("Secret Manager client not available, using fallback")
            return {}

        # Build the resource name
        if not PROJECT_ID:
            logger.warning("GOOGLE_CLOUD_PROJECT not set, cannot access Secret Manager")
            return {}

        name = f"projects/{PROJECT_ID}/secrets/{SECRET_NAME}/versions/latest"

        # Access the secret version
        response = client.access_secret_version(request={"name": name})
        secret_data = response.payload.data.decode("UTF-8")

        # Parse JSON
        users_data = json.loads(secret_data)

        # Convert to dictionary mapping username -> user data
        users_dict = {}
        for user in users_data.get("users", []):
            username = user.get("username")
            if username:
                users_dict[username] = user

        # Update cache
        _users_cache = users_dict
        _cache_timestamp = datetime.now(timezone.utc)

        logger.info(f"Loaded {len(users_dict)} users from Secret Manager")
        return users_dict

    except Exception as e:
        logger.error(f"Failed to load users from Secret Manager: {e}")
        # Return cached data if available
        if _users_cache:
            logger.info("Using cached user data due to Secret Manager error")
            return _users_cache
        return {}


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception as e:
        logger.error(f"Password verification error: {e}")
        return False


def get_password_hash(password: str) -> str:
    """Generate password hash (for admin use)."""
    return pwd_context.hash(password)


def authenticate_user(username: str, password: str) -> Optional[dict]:
    """
    Authenticate a user by username and password.
    Returns user data if successful, None otherwise.
    """
    users = load_users_from_secret_manager()
    user = users.get(username)

    if not user:
        logger.warning(f"Authentication failed: user '{username}' not found")
        return None

    if not verify_password(password, user.get("password_hash", "")):
        logger.warning(f"Authentication failed: invalid password for user '{username}'")
        return None

    logger.info(f"User '{username}' authenticated successfully")
    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)

    to_encode.update({"exp": expire, "type": "access"})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: dict) -> str:
    """Create a JWT refresh token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "type": "refresh"})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    """
    Decode and validate a JWT token.
    Returns the payload if valid, None otherwise.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError as e:
        logger.warning(f"Token decode error: {e}")
        return None


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """
    Dependency to get the current authenticated user from JWT token.
    Raises HTTPException if authentication fails.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        token = credentials.credentials
        payload = decode_token(token)

        if payload is None:
            raise credentials_exception

        # Check token type
        if payload.get("type") != "access":
            raise credentials_exception

        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception

        # Return user info from token
        return {
            "username": username,
            "role": payload.get("role", "user"),
            "user_id": username  # Use username as user_id for simplicity
        }

    except Exception as e:
        logger.error(f"Authentication error: {e}")
        raise credentials_exception


async def get_current_user_optional(credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Optional[dict]:
    """
    Optional authentication dependency.
    Returns user if authenticated, None if not.
    Useful for endpoints that work with or without auth.
    """
    if credentials is None:
        return None

    try:
        return await get_current_user(credentials)
    except HTTPException:
        return None


def generate_initial_password_hash(password: str) -> str:
    """
    Helper function to generate password hash for initial setup.
    This should be run locally, not in production code.
    """
    return get_password_hash(password)


# For development/testing: Generate a sample users JSON structure
def generate_sample_users_json(username: str, password: str) -> str:
    """
    Generate a sample users JSON for Secret Manager.
    Usage: python -c "from backend.auth import generate_sample_users_json; print(generate_sample_users_json('VerdictGroup', 'your_secure_password'))"
    """
    password_hash = get_password_hash(password)
    users_data = {
        "users": [
            {
                "username": username,
                "password_hash": password_hash,
                "role": "admin",
                "created_at": datetime.now(timezone.utc).isoformat()
            }
        ]
    }
    return json.dumps(users_data, indent=2)


if __name__ == "__main__":
    # Helper script to generate password hash
    import sys
    if len(sys.argv) > 1:
        password = sys.argv[1]
        print(f"Password hash: {get_password_hash(password)}")
    else:
        print("Usage: python auth.py <password>")
        print("Or: python -c \"from backend.auth import generate_sample_users_json; print(generate_sample_users_json('username', 'password'))\"")
