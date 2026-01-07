import logging
from typing import Dict

from fastapi import APIRouter, Body, Depends, HTTPException

try:
    from ..auth import (
        authenticate_user,
        create_access_token,
        create_refresh_token,
        get_current_user,
        decode_token,
    )
except ImportError:
    try:
        from auth import (
            authenticate_user,
            create_access_token,
            create_refresh_token,
            get_current_user,
            decode_token,
        )
    except ImportError:
        import auth as auth_module
        authenticate_user = auth_module.authenticate_user
        create_access_token = auth_module.create_access_token
        create_refresh_token = auth_module.create_refresh_token
        get_current_user = auth_module.get_current_user
        decode_token = auth_module.decode_token

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/auth/login")
async def login(credentials: Dict = Body(...)):
    """
    Authenticate user and return access and refresh tokens.

    Request body:
    {
        "username": "string",
        "password": "string"
    }
    """
    username = credentials.get("username")
    password = credentials.get("password")

    if not username or not password:
        raise HTTPException(
            status_code=400,
            detail="Username and password are required"
        )

    user = authenticate_user(username, password)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create tokens
    access_token = create_access_token(
        data={"sub": username, "role": user.get("role", "user")}
    )
    refresh_token = create_refresh_token(
        data={"sub": username, "role": user.get("role", "user")}
    )

    logger.info("User '%s' logged in successfully", username)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "username": username,
            "role": user.get("role", "user"),
        },
    }


@router.post("/api/auth/refresh")
async def refresh_token(token_data: Dict = Body(...)):
    """
    Refresh access token using refresh token.

    Request body:
    {
        "refresh_token": "string"
    }
    """
    refresh_token_value = token_data.get("refresh_token")

    if not refresh_token_value:
        raise HTTPException(
            status_code=400,
            detail="Refresh token is required"
        )

    # Decode and validate refresh token
    payload = decode_token(refresh_token_value)

    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=401,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    username = payload.get("sub")
    if not username:
        raise HTTPException(
            status_code=401,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create new access token
    access_token = create_access_token(
        data={"sub": username, "role": payload.get("role", "user")}
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
    }


@router.post("/api/auth/logout")
async def logout(current_user: dict = Depends(get_current_user)):
    """
    Logout endpoint (client should delete tokens).
    """
    logger.info("User '%s' logged out", current_user["username"])
    return {"message": "Successfully logged out"}


@router.get("/api/auth/me")
async def get_current_user_info(current_user: dict = Depends(get_current_user)):
    """Get current user information from token."""
    return {
        "username": current_user["username"],
        "role": current_user.get("role", "user"),
        "user_id": current_user["user_id"],
    }
