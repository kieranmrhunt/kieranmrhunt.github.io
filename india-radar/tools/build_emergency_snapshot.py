#!/usr/bin/env python3
"""Build a small, same-origin radar snapshot for GitHub Pages failover."""

from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ARCHIVE = PROJECT_ROOT / "radar_archive"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "fallback-data"


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.replace(temporary, path)


def copy_referenced_file(archive: Path, output: Path, relative: str) -> int:
    source = (archive / relative).resolve()
    destination = (output / relative).resolve()
    if archive.resolve() not in source.parents:
        raise ValueError(f"archive path escapes its root: {relative}")
    if output.resolve() not in destination.parents:
        raise ValueError(f"output path escapes its root: {relative}")
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination.stat().st_size


def build_snapshot(archive: Path, output: Path, window_hours: float) -> tuple[int, int, int]:
    radar = read_json(archive / "manifest.json")
    lightning = read_json(archive / "lightning" / "manifest.json")

    all_frames = sorted(radar.get("frames", []), key=lambda item: float(item["time"]))
    if not all_frames:
        raise RuntimeError("the radar manifest has no frames")

    latest = float(all_frames[-1]["time"])
    cutoff = latest - window_hours * 3600
    frames = [frame for frame in all_frames if float(frame["time"]) >= cutoff]
    if len(frames) < 2:
        frames = all_frames[-2:]

    first = float(frames[0]["time"])
    first_lightning_hour = int((first - 3600) // 3600 * 3600)
    last_lightning_hour = int(latest // 3600 * 3600)
    hours = [
        summary
        for summary in sorted(lightning.get("hours", []), key=lambda item: float(item["time"]))
        if first_lightning_hour <= float(summary["time"]) <= last_lightning_hour
    ]

    copied_bytes = 0
    for frame in frames:
        copied_bytes += copy_referenced_file(archive, output, frame["url"])
    for summary in hours:
        copied_bytes += copy_referenced_file(archive, output, summary["url"])

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot_note = {
        "kind": "same-origin emergency fallback",
        "built_at_utc": built_at,
        "window_hours": window_hours,
    }

    radar_snapshot = dict(radar)
    radar_snapshot.update(
        {
            "snapshot": snapshot_note,
            "frame_count": len(frames),
            "first_time": frames[0]["time"],
            "latest_time": frames[-1]["time"],
            "frames": frames,
            "months": [],
        }
    )
    write_json_atomic(output / "manifest.json", radar_snapshot)

    lightning_snapshot = dict(lightning)
    lightning_snapshot.update(
        {
            "snapshot": snapshot_note,
            "hour_count": len(hours),
            "stroke_count": sum(int(summary.get("count", 0)) for summary in hours),
            "first_time": min((summary.get("first_time") for summary in hours), default=None),
            "latest_time": max((summary.get("last_time") for summary in hours), default=None),
            "hours": hours,
            "months": [],
        }
    )
    write_json_atomic(output / "lightning" / "manifest.json", lightning_snapshot)

    return len(frames), len(hours), copied_bytes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--hours", type=float, default=6.0)
    args = parser.parse_args()
    if args.hours <= 0:
        parser.error("--hours must be positive")

    frame_count, hour_count, copied_bytes = build_snapshot(
        args.archive.resolve(), args.output.resolve(), args.hours
    )
    print(
        f"Emergency snapshot: {frame_count} radar frames, {hour_count} lightning hours, "
        f"{copied_bytes / 1024 / 1024:.1f} MiB"
    )


if __name__ == "__main__":
    main()
