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
from fastapi.responses import HTMLResponse, JSONResponse, Response
from playwright.async_api import async_playwright
from pydantic import BaseModel, ConfigDict, Field
from perchance import ImageGenerator
from perchance.errors import AuthenticationError

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
        "Independent Perchance service. GET /studio uses the documented browser API; "
        "server-side POST routes are best-effort because Perchance may require interactive verification. "
        "GET /healthz and /health/ready expose service health."
    ),
    version=SERVICE_VERSION,
)
_generation_lock = asyncio.Semaphore(1)
_runtime_probe_lock = asyncio.Lock()
_runtime_probe_cache: tuple[float, dict[str, object]] | None = None

STUDIO_HTML = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perchance Image Studio</title>
<style>
  :root{font-family:system-ui,sans-serif;color:#172033;background:#f3f5fb}
  body{max-width:760px;margin:36px auto;padding:0 16px}
  main{background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 32px #17243a18}
  label{display:block;margin-top:16px;font-weight:650}
  textarea,select,input,button{box-sizing:border-box;width:100%;font:inherit;padding:11px;margin-top:6px;border:1px solid #cbd2df;border-radius:8px}
  button{margin-top:20px;background:#5b4bdb;color:white;border:0;font-weight:700;cursor:pointer}
  button:disabled{opacity:.55;cursor:wait}
  #status{min-height:24px;color:#475569;margin-top:14px}
  img{display:block;max-width:100%;max-height:75vh;margin:20px auto;border-radius:12px}
  .muted{color:#657187;font-size:.92rem}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
</style>
</head>
<body><main>
<h1>Perchance Image Studio</h1>
<p class="muted">Generates in your browser through Perchance's documented Image API. No service token is used or sent to the browser.</p>
<label for="prompt">Prompt</label>
<textarea id="prompt" rows="4" maxlength="1500">A small blue bird perched on a pine branch at sunrise, detailed illustration</textarea>
<div class="row">
  <div><label for="resolution">Resolution</label><select id="resolution"><option>768x768</option><option>512x512</option><option>512x768</option><option>768x512</option></select></div>
  <div><label for="seed">Seed (optional)</label><input id="seed" type="number" placeholder="random"></div>
</div>
<button id="generate">Generate with Perchance</button>
<div id="status" role="status" aria-live="polite">Ready.</div>
<img id="result" alt="Generated image" hidden>
<a id="open" target="_blank" rel="noopener noreferrer" hidden>Open original image</a>
<p class="muted">The first request warms up Perchance. Generation may take up to 3 minutes. If Perchance blocks the request, this page reports the error; it does not attempt to bypass that protection.</p>
</main>
<script>
const ORIGIN='https://perchance.org';
let warmed=false, warmPromise;
function warmUp(){
  if(warmed)return Promise.resolve(true);
  if(warmPromise)return warmPromise;
  warmPromise=new Promise(resolve=>{
    const frame=document.createElement('iframe');
    frame.title='Perchance warm-up';frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
    frame.style.cssText='width:1px;height:1px;border:0;position:absolute;opacity:0';
    frame.src=ORIGIN;
    let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);frame.remove();warmed=ok;if(!ok)warmPromise=null;resolve(ok)};
    const timer=setTimeout(()=>finish(false),15000);
    frame.onload=()=>setTimeout(()=>finish(true),500);
    frame.onerror=()=>finish(false);
    document.body.appendChild(frame);
  });
  return warmPromise;
}
function generateImage(prompt,resolution,seed){
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const params=new URLSearchParams({prompt,format:'json',id,resolution});
    if(seed!=='')params.set('seed',seed);
    const frame=document.createElement('iframe');
    frame.title='Perchance image request';frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
    frame.style.cssText='width:1px;height:1px;border:0;position:absolute;opacity:0';
    frame.src=ORIGIN+'/perchance-ai-api?'+params.toString();
    let settled=false;
    const cleanup=()=>{window.removeEventListener('message',onMessage);clearTimeout(timer);frame.remove()};
    const finish=(error,result)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(result)};
    const onMessage=event=>{
      if(event.origin!==ORIGIN||event.source!==frame.contentWindow)return;
      const data=event.data||{},result=data.result;
      if(data.api!=='perchance-image-api'||!result||result.id!==id)return;
      if(!result.ok||!result.url){finish(new Error(result.error||'Perchance image generation failed'));return}
      try{const url=new URL(result.url);if(url.protocol!=='https:')throw new Error('Perchance returned a non-HTTPS URL');finish(null,result)}
      catch(error){finish(error)}
    };
    window.addEventListener('message',onMessage);
    const timer=setTimeout(()=>finish(new Error('Perchance image generation timed out after 180 seconds')),180000);
    document.body.appendChild(frame);
  });
}
const button=document.querySelector('#generate'),status=document.querySelector('#status'),image=document.querySelector('#result'),link=document.querySelector('#open');
button.addEventListener('click',async()=>{
  const prompt=document.querySelector('#prompt').value.trim();
  if(!prompt){status.textContent='Enter a prompt first.';return}
  button.disabled=true;image.hidden=true;link.hidden=true;
  status.textContent='Warming up Perchance…';
  try{
    await warmUp();
    status.textContent='Generating in the browser… this can take up to 3 minutes.';
    const result=await generateImage(prompt,document.querySelector('#resolution').value,document.querySelector('#seed').value.trim());
    image.src=result.url;image.hidden=false;link.href=result.url;link.hidden=false;
    status.textContent='Generated by Perchance. Seed: '+(result.seed??'not returned');
  }catch(error){status.textContent='Perchance generation failed: '+(error instanceof Error?error.message:String(error))}
  finally{button.disabled=false}
});
</script>
</body></html>'''


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
            "studio": "GET /studio (official browser-based generation)",
            "liveness": "GET /health/live",
            "readiness": "GET /health/ready or GET /api/health",
            "diagnostics": "GET /api/test",
            "generation": "POST /perchance",
            "liveGenerationTest": "POST /api/test/generate",
            "openapi": "GET /openapi.json",
            "swaggerUi": "GET /docs",
            "redoc": "GET /redoc",
        },
        "authentication": {
            "serverRoutes": "X-Perchance-Service-Token is required for POST /perchance and POST /api/test/generate",
            "browserStudio": "GET /studio does not expose or require the service token",
        },
        "generation": {
            "timeoutSeconds": GENERATION_TIMEOUT_SECONDS,
            "maxConcurrentRequests": 1,
            "maxImageBytes": MAX_IMAGE_BYTES,
            "shapes": ["portrait", "square", "landscape"],
        },
    }


@app.get("/studio", response_class=HTMLResponse)
async def studio() -> HTMLResponse:
    """Official browser-based Perchance generation; no backend service token is exposed."""
    return HTMLResponse(content=STUDIO_HTML)


@app.get("/perchance")
async def generation_route_info() -> dict[str, object]:
    return {
        "route": "POST /perchance",
        "description": "Attempt server-side generation; Perchance may require its official browser verification. Use GET /studio for the supported browser-based path.",
        "browserStudio": "/studio",
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
            "note": "Attempts server-side generation; Perchance may require a browser session.",
            "browserAlternative": "/studio",
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
    except AuthenticationError:
        logger.warning(
            "Perchance did not provide a server-side user key; use the documented browser studio at /studio"
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PERCHANCE_BROWSER_VERIFICATION_REQUIRED",
                "message": "Perchance did not authorize server-side generation. No image was generated.",
                "supportedAlternative": "/studio",
                "note": "Use the official browser flow or request an authorized server API from Perchance.",
            },
        ) from None
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
