"""SOHAM's isolated Perchance Playwright service.

This service intentionally uses the third-party `perchance` package. That
package automates Perchance's browser flow and depends on upstream internals;
keep it isolated from SOHAM's main Node process and do not add provider fallback.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import mimetypes
import os
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from perchance import ImageGenerator

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("soham-perchance")
app = FastAPI(title="SOHAM Perchance Service", docs_url=None, redoc_url=None)
_generation_lock = asyncio.Semaphore(1)


class PerchanceRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1, max_length=1500)
    shape: Literal["portrait", "square", "landscape"] = "square"
    negative_prompt: str | None = Field(default=None, max_length=500, alias="negativePrompt")
    seed: int = Field(default=-1, ge=-1, le=2**31 - 1)
    guidance_scale: float = Field(default=7.0, ge=1.0, le=30.0, alias="guidanceScale")


@app.get("/healthz")
async def health() -> dict[str, str | bool]:
    # Capability/liveness only; deliberately does not call Perchance.
    return {"ok": True, "service": "soham-perchance", "tokenConfigured": bool(os.getenv("PERCHANCE_SERVICE_TOKEN"))}


@app.post("/perchance")
async def generate(
    body: PerchanceRequest,
    x_perchance_service_token: str | None = Header(default=None),
) -> Response:
    expected = os.getenv("PERCHANCE_SERVICE_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="Perchance service authentication is not configured")
    if not x_perchance_service_token or not hmac.compare_digest(x_perchance_service_token, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")

    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="prompt cannot be blank")
    if _generation_lock.locked():
        raise HTTPException(status_code=429, detail="Perchance is busy; retry after the current image finishes")

    try:
        await asyncio.wait_for(_generation_lock.acquire(), timeout=0.05)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=429, detail="Perchance is busy; retry after the current image finishes") from exc

    try:
        async def run_generation():
            async with ImageGenerator() as generator:
                result = await generator.image(
                    prompt,
                    negative_prompt=body.negative_prompt,
                    seed=body.seed,
                    shape=body.shape,
                    guidance_scale=body.guidance_scale,
                )
                image_bytes = await result.download()
                return result, image_bytes.getvalue()

        result, image_bytes = await asyncio.wait_for(run_generation(), timeout=240)
        if not image_bytes or len(image_bytes) > 12 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Generated image is empty or exceeds the size limit")
        extension = (result.file_extension or "png").lower().lstrip(".")
        media_type = mimetypes.types_map.get(f".{extension}", "application/octet-stream")
        return Response(
            content=image_bytes,
            media_type=media_type,
            headers={
                "Cache-Control": "no-store",
                "X-Perchance-Seed": str(result.seed),
                "X-Perchance-Width": str(result.width),
                "X-Perchance-Height": str(result.height),
                "X-Perchance-Extension": extension,
            },
        )
    except asyncio.TimeoutError as exc:
        logger.warning("Perchance image request timed out")
        raise HTTPException(status_code=504, detail="Perchance image generation timed out") from exc
    except HTTPException:
        raise
    except Exception as exc:  # Never send upstream internals to callers.
        logger.exception("Perchance image generation failed")
        raise HTTPException(status_code=502, detail="Perchance image generation failed") from exc
    finally:
        _generation_lock.release()
