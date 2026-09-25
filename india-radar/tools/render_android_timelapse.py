#!/usr/bin/env python3
"""Render the India radar dashboard as an Android-sized 72-hour timelapse."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import signal
import statistics
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import websocket


ANDROID_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.007) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 "
    "Mobile Safari/537.36"
)

LEAFLET_CAPTURE_HOOK = r"""
(() => {
  let leaflet;
  Object.defineProperty(window, 'L', {
    configurable: true,
    get() { return leaflet; },
    set(value) {
      if (value && typeof value.map === 'function' && !value.map.__captureWrapped) {
        const originalMap = value.map;
        const wrappedMap = function (...args) {
          const map = originalMap.apply(this, args);
          window.__indiaRadarCaptureMap = map;
          return map;
        };
        wrappedMap.__captureWrapped = true;
        value.map = wrappedMap;
      }
      leaflet = value;
    },
  });
})();
"""


class Cdp:
    def __init__(self, websocket_url: str) -> None:
        self.ws = websocket.create_connection(
            websocket_url,
            timeout=45,
            http_proxy_host=None,
            origin="http://127.0.0.1",
        )
        self.sequence = 0
        self.requests: list[str] = []
        self.errors: list[str] = []

    def close(self) -> None:
        self.ws.close()

    def _event(self, message: dict) -> None:
        method = message.get("method")
        params = message.get("params", {})
        if method == "Network.requestWillBeSent":
            url = params.get("request", {}).get("url")
            if url:
                self.requests.append(url)
        elif method == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails", {})
            text = detail.get("text", "Uncaught runtime exception")
            exception = detail.get("exception", {}).get("description")
            self.errors.append(exception or text)
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            if entry.get("level") == "error":
                self.errors.append(entry.get("text", "Browser log error"))

    def call(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        request_id = self.sequence
        self.ws.send(json.dumps({
            "id": request_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            self._event(message)

    def evaluate(self, expression: str, await_promise: bool = False):
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": await_promise,
            "returnByValue": True,
            "userGesture": True,
        })
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise RuntimeError(remote.get("description", "JavaScript evaluation failed"))
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"].get("text", "JavaScript exception"))
        return remote.get("value")


def read_json(url: str):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=10) as response:
        return json.load(response)


def wait_for_devtools(profile: Path, process: subprocess.Popen, timeout: float = 30) -> int:
    marker = profile / "DevToolsActivePort"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Chrome exited early with status {process.returncode}")
        if marker.exists():
            lines = marker.read_text().splitlines()
            if lines:
                return int(lines[0])
        time.sleep(0.1)
    raise TimeoutError("Chrome did not expose a DevTools port")


def wait_for_page(port: int, url_fragment: str, timeout: float = 30) -> str:
    deadline = time.monotonic() + timeout
    endpoint = f"http://127.0.0.1:{port}/json"
    while time.monotonic() < deadline:
        for target in read_json(endpoint):
            if target.get("type") == "page" and url_fragment in target.get("url", ""):
                return target["webSocketDebuggerUrl"]
        time.sleep(0.1)
    raise TimeoutError("Dashboard page did not appear in DevTools")


def wait_for_dashboard(cdp: Cdp, timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    last_state = None
    expression = r"""
(() => {
  const loading = document.querySelector('#mapLoading');
  const range = document.querySelector('#timeRange');
  const lightning = document.querySelector('#lightningKey');
  return {
    ready: Boolean(
      loading && loading.hidden
      && range && !range.disabled
      && Number(range.max) > 0
      && window.__indiaRadarCaptureMap
      && window.__indiaRadarCapture
    ),
    loading: loading ? loading.hidden : null,
    disabled: range ? range.disabled : null,
    max: range ? Number(range.max) : null,
    lightning: lightning ? lightning.dataset.state : null,
    text: document.querySelector('#loadingText')?.textContent || '',
  };
})()
"""
    while time.monotonic() < deadline:
        last_state = cdp.evaluate(expression)
        if last_state and last_state.get("ready"):
            return
        time.sleep(0.25)
    raise TimeoutError(f"Dashboard did not become ready: {last_state}")


def settle(cdp: Cdp, milliseconds: int = 80) -> None:
    cdp.evaluate(
        f"new Promise(resolve => requestAnimationFrame(() => "
        f"requestAnimationFrame(() => setTimeout(resolve, {milliseconds}))))",
        await_promise=True,
    )


def fit_capture_bounds(
    cdp: Cdp,
    south: float,
    west: float,
    north: float,
    east: float,
) -> dict:
    expression = f"""
(() => {{
  const map = window.__indiaRadarCaptureMap;
  const timeline = document.querySelector('#timeline').getBoundingClientRect();
  const bottomPadding = Math.max(12, window.innerHeight - timeline.top + 10);
  map.invalidateSize({{ pan: false, animate: false }});
  map.fitBounds(
    [[{south}, {west}], [{north}, {east}]],
    {{
      paddingTopLeft: [10, 58],
      paddingBottomRight: [10, bottomPadding],
      animate: false,
    }}
  );
  const bounds = map.getBounds();
  return {{
    timelineTop: timeline.top,
    paddingBottom: bottomPadding,
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
    zoom: map.getZoom(),
  }};
}})()
"""
    result = cdp.evaluate(expression)
    settle(cdp, 450)
    return result


def set_slider(cdp: Cdp, index: float, delay_ms: int) -> None:
    expression = f"""
new Promise((resolve) => {{
  const range = document.querySelector('#timeRange');
  range.value = String({index:.9f});
  range.dispatchEvent(new Event('input', {{ bubbles: true }}));
  requestAnimationFrame(() => requestAnimationFrame(
    () => setTimeout(resolve, {delay_ms})
  ));
}})
"""
    cdp.evaluate(expression, await_promise=True)


def render_high_resolution(cdp: Cdp, index: float, delay_ms: int) -> list[dict]:
    expression = f"""
(async () => {{
  await window.__indiaRadarCapture.renderHighResolution({index:.9f});
  await new Promise((resolve) => requestAnimationFrame(
    () => setTimeout(resolve, {delay_ms})
  ));
  return [...document.querySelectorAll('.leaflet-radar-pane img.leaflet-image-layer')]
    .filter((image) => image.src.includes('/frames/'))
    .map((image) => ({{
      width: image.naturalWidth,
      height: image.naturalHeight,
      complete: image.complete,
      opacity: Number(image.style.opacity || 0),
    }}));
}})()
"""
    return cdp.evaluate(expression, await_promise=True)


def dashboard_snapshot(cdp: Cdp) -> dict:
    expression = r"""
(() => {
  const range = document.querySelector('#timeRange');
  const map = window.__indiaRadarCaptureMap;
  const bounds = map.getBounds();
  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    captureWindow: window.__indiaRadarCapture.windowInfo(),
    timeline: {
      min: Number(range.min),
      max: Number(range.max),
      value: Number(range.value),
      step: range.step,
      spanSeconds: Number(range.max) * 300,
      rangeStart: document.querySelector('#rangeStart').textContent,
      rangeEnd: document.querySelector('#rangeEnd').textContent,
      selectedTime: document.querySelector('#selectedTime').textContent,
      selectedDate: document.querySelector('#selectedDate').textContent,
      dateMin: document.querySelector('#datePicker').min,
      dateMax: document.querySelector('#datePicker').max,
      summary: document.querySelector('#archiveSummary').textContent,
    },
    layers: {
      rain: document.querySelector('#rainButton').getAttribute('aria-pressed'),
      lightning: document.querySelector('#lightningButton').getAttribute('aria-pressed'),
      lightningSummary: document.querySelector('#lightningSummary').textContent,
    },
    map: {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
      zoom: map.getZoom(),
    },
    layout: {
      timeline: document.querySelector('#timeline').getBoundingClientRect().toJSON(),
      lightningKey: document.querySelector('#lightningKey').getBoundingClientRect().toJSON(),
      radarKey: document.querySelector('#radarKey').getBoundingClientRect().toJSON(),
    },
  };
})()
"""
    return cdp.evaluate(expression)


def test_layer_toggles(cdp: Cdp) -> dict:
    expression = r"""
(() => {
  const rain = document.querySelector('#rainButton');
  const lightning = document.querySelector('#lightningButton');
  rain.click();
  const rainOff = rain.getAttribute('aria-pressed');
  rain.click();
  const rainOn = rain.getAttribute('aria-pressed');
  lightning.click();
  const lightningOff = lightning.getAttribute('aria-pressed');
  lightning.click();
  const lightningOn = lightning.getAttribute('aria-pressed');
  return { rainOff, rainOn, lightningOff, lightningOn };
})()
"""
    result = cdp.evaluate(expression)
    settle(cdp, 120)
    return result


def scrub_benchmark(cdp: Cdp, samples: int = 120) -> dict:
    expression = f"""
(async () => {{
  const range = document.querySelector('#timeRange');
  const maximum = Number(range.max);
  const durations = [];
  const started = performance.now();
  for (let sample = 0; sample < {samples}; sample += 1) {{
    const value = maximum * sample / ({samples} - 1);
    const before = performance.now();
    range.value = String(value);
    range.dispatchEvent(new Event('input', {{ bubbles: true }}));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    durations.push(performance.now() - before);
  }}
  return {{ durations, total: performance.now() - started }};
}})()
"""
    result = cdp.evaluate(expression, await_promise=True)
    values = sorted(float(value) for value in result["durations"])
    percentile_index = max(0, min(len(values) - 1, math.ceil(0.95 * len(values)) - 1))
    return {
        "samples": samples,
        "totalMs": round(float(result["total"]), 1),
        "medianFrameMs": round(statistics.median(values), 2),
        "p95FrameMs": round(values[percentile_index], 2),
        "maxFrameMs": round(max(values), 2),
    }


def pack_days(urls: list[str], parameter: str) -> list[str]:
    days = set()
    for url in urls:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        for value in query.get(parameter, []):
            days.add(value)
        suffix = ".rgp" if parameter == "radar_pack" else ".ldp"
        if parsed.path.endswith(suffix):
            match = re.search(r"(20\d{2}-\d{2}-\d{2})", parsed.path)
            if match:
                days.add(match.group(1))
    return sorted(days)


def data_requests(urls: list[str]) -> list[str]:
    markers = (
        "radar_pack=", "lightning_pack=", "lightning_bin=",
        "/scrub/days/", "/lightning/packs/days/", "/previews/", "/frames/",
    )
    return [url for url in urls if any(marker in url for marker in markers)]


def capture_screenshot(cdp: Cdp, path: Path, quality: int = 90) -> None:
    result = cdp.call("Page.captureScreenshot", {
        "format": "jpeg",
        "quality": quality,
        "fromSurface": True,
        "captureBeyondViewport": False,
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(result["data"]))


def encode_video(frames_dir: Path, output: Path, fps: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-framerate", str(fps),
        "-i", str(frames_dir / "frame_%04d.jpg"),
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-metadata", "title=India rain and lightning — previous 72 hours",
        str(output),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError(f"ffmpeg failed: {completed.stderr.strip()}")


def render_frames(
    cdp: Cdp,
    frames_dir: Path,
    frame_count: int,
    delay_ms: int,
    quality: int,
) -> None:
    maximum = float(cdp.evaluate(
        "Number(document.querySelector('#timeRange').max)"
    ))
    for frame_number in range(frame_count):
        ratio = frame_number / max(1, frame_count - 1)
        layers = render_high_resolution(cdp, maximum * ratio, delay_ms)
        if not any(
            layer["complete"] and layer["width"] >= 1000 and layer["height"] >= 1000
            for layer in layers
        ):
            raise RuntimeError(f"Full-resolution radar was not ready at frame {frame_number}")
        capture_screenshot(
            cdp,
            frames_dir / f"frame_{frame_number:04d}.jpg",
            quality,
        )
        if frame_number == 0 or (frame_number + 1) % 60 == 0 or frame_number + 1 == frame_count:
            print(f"Captured {frame_number + 1}/{frame_count} frames", flush=True)


def utc_epoch(value: str) -> int:
    normalised = value.strip()
    if normalised.endswith("Z"):
        normalised = normalised[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"invalid ISO-8601 time: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    epoch = int(parsed.timestamp())
    if epoch % 300:
        raise argparse.ArgumentTypeError("end time must fall on a five-minute boundary")
    return epoch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765/india-radar/")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--qa-json", type=Path)
    parser.add_argument("--qa-only", action="store_true")
    parser.add_argument(
        "--end-time-utc",
        type=utc_epoch,
        help="pin the 72-hour window to an ISO-8601 end time",
    )
    parser.add_argument("--width", type=int, default=390)
    parser.add_argument("--height", type=int, default=633)
    parser.add_argument("--device-scale-factor", type=float, default=2)
    parser.add_argument("--south", type=float, default=4.0)
    parser.add_argument("--west", type=float, default=73.0)
    parser.add_argument("--north", type=float, default=31.5)
    parser.add_argument("--east", type=float, default=90.0)
    parser.add_argument("--frames", type=int, default=865)
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--settle-ms", type=int, default=24)
    parser.add_argument("--jpeg-quality", type=int, default=88)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.qa_only and not args.output:
        raise SystemExit("--output is required unless --qa-only is used")
    chrome = shutil.which("google-chrome")
    if not chrome:
        raise SystemExit("google-chrome is not installed")

    with tempfile.TemporaryDirectory(prefix="india-radar-chrome-") as profile_name:
        profile = Path(profile_name)

        parsed_url = urllib.parse.urlsplit(args.url)
        query = urllib.parse.parse_qsl(parsed_url.query, keep_blank_values=True)
        query = [
            (key, value)
            for key, value in query
            if key not in {"capture", "captureEndEpoch"}
        ]
        query.append(("capture", "1"))
        if args.end_time_utc is not None:
            query.append(("captureEndEpoch", str(args.end_time_utc)))
        capture_url = urllib.parse.urlunsplit(parsed_url._replace(
            query=urllib.parse.urlencode(query),
        ))
        chrome_command = [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-extensions",
            "--disable-background-networking",
            "--no-first-run",
            "--remote-allow-origins=*",
            "--remote-debugging-port=0",
            f"--user-data-dir={profile}",
            f"--window-size={args.width},{args.height}",
            capture_url,
        ]
        process = subprocess.Popen(
            chrome_command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        cdp = None
        try:
            port = wait_for_devtools(profile, process)
            websocket_url = wait_for_page(port, urllib.parse.urlparse(capture_url).path)
            cdp = Cdp(websocket_url)
            for domain in ("Page", "Runtime", "Network", "Log"):
                cdp.call(f"{domain}.enable")
            cdp.call("Page.addScriptToEvaluateOnNewDocument", {
                "source": LEAFLET_CAPTURE_HOOK,
            })
            cdp.call("Emulation.setUserAgentOverride", {
                "userAgent": ANDROID_USER_AGENT,
                "platform": "Android",
            })
            cdp.call("Emulation.setDeviceMetricsOverride", {
                "width": args.width,
                "height": args.height,
                "deviceScaleFactor": args.device_scale_factor,
                "mobile": True,
                "screenWidth": args.width,
                "screenHeight": args.height,
                "positionX": 0,
                "positionY": 0,
                "dontSetVisibleSize": False,
            })
            cdp.call("Emulation.setTouchEmulationEnabled", {
                "enabled": True,
                "maxTouchPoints": 5,
            })
            cdp.requests.clear()
            cdp.call("Page.reload", {"ignoreCache": True})
            wait_for_dashboard(cdp)
            capture_bounds = fit_capture_bounds(
                cdp,
                args.south,
                args.west,
                args.north,
                args.east,
            )
            toggles = test_layer_toggles(cdp)
            settle(cdp, 500)

            requests_before = len(cdp.requests)
            scrub = scrub_benchmark(cdp)
            settle(cdp, 500)
            scrub_urls = cdp.requests[requests_before:]
            maximum = float(cdp.evaluate(
                "Number(document.querySelector('#timeRange').max)"
            ))
            high_resolution_radar = render_high_resolution(cdp, maximum, args.settle_ms)
            qa = dashboard_snapshot(cdp)
            qa.update({
                "requestedBounds": {
                    "south": args.south,
                    "west": args.west,
                    "north": args.north,
                    "east": args.east,
                },
                "captureFit": capture_bounds,
                "toggles": toggles,
                "scrub": {
                    **scrub,
                    "newDataRequests": data_requests(scrub_urls),
                },
                "packs": {
                    "radarDays": pack_days(cdp.requests, "radar_pack"),
                    "lightningDays": pack_days(cdp.requests, "lightning_pack"),
                },
                "browserErrors": cdp.errors,
                "highResolutionRadar": high_resolution_radar,
                "requestedEndEpoch": args.end_time_utc,
            })

            span = qa["timeline"]["spanSeconds"]
            if not (71.9 * 3600 <= span <= 72.01 * 3600):
                raise RuntimeError(f"Unexpected timeline span: {span} seconds")
            if (
                args.end_time_utc is not None
                and qa["captureWindow"]["last"] != args.end_time_utc
            ):
                raise RuntimeError(
                    f"Unexpected timeline end: {qa['captureWindow']['last']}"
                )

            if len(qa["packs"]["radarDays"]) > 5 or len(qa["packs"]["lightningDays"]) > 5:
                raise RuntimeError(f"Too many daily packs loaded: {qa['packs']}")
            if qa["toggles"] != {
                "rainOff": "false",
                "rainOn": "true",
                "lightningOff": "false",
                "lightningOn": "true",
            }:
                raise RuntimeError(f"Layer toggles failed: {qa['toggles']}")

            if not any(
                layer["complete"] and layer["width"] >= 1000 and layer["height"] >= 1000
                for layer in qa["highResolutionRadar"]
            ):
                raise RuntimeError("High-resolution radar validation failed")

            rendered_qa = json.dumps(qa, indent=2, sort_keys=True)
            print(rendered_qa, flush=True)
            if args.qa_json:
                args.qa_json.parent.mkdir(parents=True, exist_ok=True)
                args.qa_json.write_text(rendered_qa + "\n")
            if args.preview:
                capture_screenshot(cdp, args.preview, args.jpeg_quality)

            if not args.qa_only:
                with tempfile.TemporaryDirectory(prefix="india-radar-frames-") as frames_name:
                    frames_dir = Path(frames_name)
                    render_frames(
                        cdp,
                        frames_dir,
                        args.frames,
                        args.settle_ms,
                        args.jpeg_quality,
                    )
                    encode_video(frames_dir, args.output, args.fps)
                print(f"Wrote {args.output}", flush=True)
        finally:
            if cdp is not None:
                cdp.close()
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            time.sleep(0.25)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
