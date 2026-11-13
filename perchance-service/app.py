"""Standalone Perchance image-generation HTTP service.

This service is deployable independently of SOHAM's Node backend. The optional
Node proxy may call POST /perchance, but this app has its own API, diagnostics,
health endpoints, and authentication token.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import mimetypes
import os
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response
from playwright.async_api import async_playwright
from pydantic import BaseModel, ConfigDict, Field
from perchance import ImageGenerator

SERVICE_NAME = "soham-perchance"
SERVICE_VERSION = os.getenv("SERVICE_VERSION", "1.0.0")
GENERATION_TIMEOUT_SECONDS = 240
MAX_IMAGE_BYTES = 12 * 1024 * 1024
DEFAULT_TEST_PROMPT = "A small blue bird perched on a pine branch at sunrise, detailed illustration"
STARTED_AT = time.time()

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(SERVICE_NAME)
app = FastAPI(
    title="Standalone Perchance Image API",
    description=(
        "Independent HTTP service for Perchance image generation. "
        "POST /perchance generates an image; GET /healthz, /health/ready, "
        "and /api/test expose service diagnostics."
    ),
    version=SERVICE_VERSION,
)
_generation_lock = asyncio.Semaphore(1)
_runtime_probe_lock = asyncio.Lock()
_runtime_probe_cache: tuple[float, dict[str, object]] | None = None


class PerchanceRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1, max_length=1500, description="What to draw")
    shape: Literal["portrait", "square", "landscape"] = Field(default="square")
    negative_prompt: str | None = Field(default=None, max_length=500, alias="negativePrompt")
    seed: int = Field(default=-1, ge=-1, le=2**31 - 1, description="Use -1 for a random seed")
    guidance_scale: float = Field(default=7.0, ge=1.0, le=30.0, alias="guidanceScale")


def _package_version(package: str) -> str | None:
    try:
        return version(package)
    except PackageNotFoundError:
        return None


async def _runtime_status() -> dict[str, object]:
    """Check the local Playwright driver and Chromium binary, cached for 30s.

    This does not contact Perchance or generate an image.
    """
    global _runtime_probe_cache
    now = time.monotonic()
    if _runtime_probe_cache and _runtime_probe_cache[0] > now:
        return dict(_runtime_probe_cache[1])

    async with _runtime_probe_lock:
        now = time.monotonic()
        if _runtime_probe_cache and _runtime_probe_cache[0] > now:
            return dict(_runtime_probe_cache[1])

        try:
            async with async_playwright() as playwright:
                chromium_path = Path(playwright.chromium.executable_path)
                result: dict[str, object] = {
                    "playwrightDriver": "ok",
                    "chromiumInstalled": chromium_path.is_file(),
                }
        except Exception as exc:
            logger.warning("Playwright runtime check failed: %s", exc)
            result = {
                "playwrightDriver": "error",
                "chromiumInstalled": False,
                "runtimeError": str(exc)[:240],
            }

        result["playwrightVersion"] = _package_version("playwright")
        result["perchancePackageVersion"] = _package_version("perchance")
        _runtime_probe_cache = (time.monotonic() + 30, result)
        return dict(result)


@app.api_route("/", methods=["GET", "HEAD"])
async def root() -> dict[str, object]:
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "description": "Standalone Perchance image-generation service",
        "endpoints": {
            "health": "GET /healthz",
            "liveness": "GET /health/live",
            "readiness": "GET /health/ready or GET /api/health",
            "diagnostics": "GET /api/test",
            "generation": "POST /perchance",
            "liveGenerationTest": "POST /api/test/generate",
            "openapi": "GET /openapi.json",
            "swaggerUi": "GET /docs",
            "redoc": "GET /redoc",
        },
        "authentication": "X-Perchance-Service-Token is required for generation routes",
        "generation": {
            "timeoutSeconds": GENERATION_TIMEOUT_SECONDS,
            "maxConcurrentRequests": 1,
            "maxImageBytes": MAX_IMAGE_BYTES,
            "shapes": ["portrait", "square", "landscape"],
        },
    }


@app.get("/perchance")
async def generation_route_info() -> dict[str, object]:
    return {
        "route": "POST /perchance",
        "description": "Generate an image; response body is the image binary.",
        "authHeader": "X-Perchance-Service-Token",
        "requestExample": {
            "prompt": "A fox under a pine tree in snowfall",
            "shape": "square",
            "negativePrompt": "text, watermark",
            "seed": -1,
            "guidanceScale": 7,
        },
        "responseHeaders": [
            "Content-Type", "X-Perchance-Seed", "X-Perchance-Width", "X-Perchance-Height"
        ],
    }


@app.get("/healthz")
@app.get("/health/live")
async def liveness() -> dict[str, object]:
    """Cheap process liveness; intentionally does not start Chromium or call Perchance."""
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "uptimeSeconds": round(time.time() - STARTED_AT, 1),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def _readiness_report() -> dict[str, object]:
    runtime = await _runtime_status()
    token_configured = bool(os.getenv("PERCHANCE_SERVICE_TOKEN"))
    browser_ready = runtime.get("playwrightDriver") == "ok" and runtime.get("chromiumInstalled") is True
    ready = token_configured and browser_ready
    return {
        "status": "ready" if ready else "not_ready",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checks": {
            "httpProcess": "ok",
            "serviceTokenConfigured": token_configured,
            **runtime,
            "perchanceReachability": "not_probed",
        },
        "routes": {
            "generate": "POST /perchance",
            "liveTest": "POST /api/test/generate",
            "diagnostics": "GET /api/test",
        },
    }


@app.get("/health/ready")
@app.get("/api/health")
async def readiness() -> JSONResponse:
    """Detailed local readiness; 503 if auth config or local Chromium is missing."""
    report = await _readiness_report()
    return JSONResponse(status_code=200 if report["status"] == "ready" else 503, content=report)


@app.get("/api/test")
async def diagnostics() -> dict[str, object]:
    """Non-generative diagnostics for deployment checks."""
    ready_info = await _readiness_report()
    return {
        **ready_info,
        "testMode": "diagnostic_only",
        "liveGenerationTest": {
            "method": "POST",
            "path": "/api/test/generate",
            "requiresAuth": True,
            "note": "Actually generates an image and uses service resources.",
            "defaultPrompt": DEFAULT_TEST_PROMPT,
        },
    }


async def _generate_image(body: PerchanceRequest, supplied_token: str | None, live_test: bool = False) -> Response:
    expected_token = os.getenv("PERCHANCE_SERVICE_TOKEN", "")
    if not expected_token:
        raise HTTPException(status_code=503, detail="PERCHANCE_SERVICE_TOKEN is not configured")
    if not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(status_code=401, detail="Unauthorized: provide X-Perchance-Service-Token")

    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="prompt cannot be blank")
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

        result, image_bytes = await asyncio.wait_for(run_generation(), timeout=GENERATION_TIMEOUT_SECONDS)
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Generated image is empty or exceeds the size limit")
        extension = (result.file_extension or "png").lower().lstrip(".")
        media_type = mimetypes.types_map.get(f".{extension}", "application/octet-stream")
        headers = {
            "Cache-Control": "no-store",
            "X-Perchance-Seed": str(result.seed),
            "X-Perchance-Width": str(result.width),
            "X-Perchance-Height": str(result.height),
            "X-Perchance-Extension": extension,
            "X-Perchance-Service": SERVICE_NAME,
        }
        if live_test:
            headers["X-Perchance-Live-Test"] = "passed"
        return Response(content=image_bytes, media_type=media_type, headers=headers)
    except asyncio.TimeoutError as exc:
        logger.warning("Perchance image request timed out")
        raise HTTPException(status_code=504, detail="Perchance image generation timed out") from exc
    except HTTPException:
        raise
    except Exception as exc:  # Do not expose upstream internals/secrets to clients.
        logger.exception("Perchance image generation failed")
        raise HTTPException(status_code=502, detail="Perchance image generation failed") from exc
    finally:
        _generation_lock.release()


@app.post("/perchance", summary="Generate an image")
async def generate(
    body: PerchanceRequest,
    x_perchance_service_token: str | None = Header(default=None),
) -> Response:
    """Generate and return image bytes. See GET /perchance for request details."""
    return await _generate_image(body, x_perchance_service_token)


@app.post("/api/test/generate", summary="Run a live Perchance generation test")
async def live_generation_test(
    body: PerchanceRequest | None = Body(default=None),
    x_perchance_service_token: str | None = Header(default=None),
) -> Response:
    """Generates a real image; if body is omitted, uses a built-in test prompt."""
    test_request = body or PerchanceRequest(prompt=DEFAULT_TEST_PROMPT, shape="square")
    return await _generate_image(test_request, x_perchance_service_token, live_test=True)
