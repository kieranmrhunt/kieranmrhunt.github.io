#!/usr/bin/env python3
"""Build the compact India land mask used by the browser stroke counter.

The output is a 40-byte little-endian header followed by one row-major bit per
cell.  It deliberately uses the same Natural Earth India-viewpoint boundary as
the daily research figure, at a coarser resolution suited to the 2--3 km radar
display.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BOUNDARY = (
    PROJECT_ROOT / "boundaries" / "ne_10m_admin_0_countries_ind.geojson"
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "india-land-mask.bin"
DEFAULT_RESOLUTION = 0.02
MAGIC = b"INDMSK1\0"


def india_polygons(path: Path) -> list:
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    for feature in document.get("features", []):
        properties = feature.get("properties", {})
        if (
            properties.get("ADM0_A3") == "IND"
            or properties.get("ISO_A3") == "IND"
            or properties.get("ADMIN") == "India"
        ):
            geometry = feature["geometry"]
            if geometry["type"] == "Polygon":
                return [geometry["coordinates"]]
            if geometry["type"] == "MultiPolygon":
                return geometry["coordinates"]
            raise ValueError(f"unsupported India geometry: {geometry['type']}")
    raise ValueError(f"India feature not found in {path}")


def rasterise(polygons: list, resolution: float) -> tuple[np.ndarray, float, float]:
    coordinates = [
        (float(longitude), float(latitude))
        for polygon in polygons
        for ring in polygon
        for longitude, latitude in ring
    ]
    west = math.floor(min(point[0] for point in coordinates) / resolution) * resolution
    east = math.ceil(max(point[0] for point in coordinates) / resolution) * resolution
    south = math.floor(min(point[1] for point in coordinates) / resolution) * resolution
    north = math.ceil(max(point[1] for point in coordinates) / resolution) * resolution
    width = int(round((east - west) / resolution)) + 1
    height = int(round((north - south) / resolution)) + 1
    image = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(image)

    def pixels(ring: list) -> list[tuple[int, int]]:
        return [
            (
                int(round((float(longitude) - west) / resolution)),
                int(round((north - float(latitude)) / resolution)),
            )
            for longitude, latitude in ring
        ]

    for polygon in polygons:
        if not polygon:
            continue
        draw.polygon(pixels(polygon[0]), fill=1)
        for hole in polygon[1:]:
            draw.polygon(pixels(hole), fill=0)
    return np.asarray(image, dtype=np.uint8), west, north


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--resolution", type=float, default=DEFAULT_RESOLUTION)
    arguments = parser.parse_args()
    if not 0 < arguments.resolution <= 0.1:
        parser.error("--resolution must be greater than zero and no more than 0.1")

    mask, west, north = rasterise(
        india_polygons(arguments.boundary), arguments.resolution
    )
    height, width = mask.shape
    payload = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
    header = struct.pack(
        "<8sIIddd", MAGIC, width, height, west, north, arguments.resolution
    )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = arguments.output.with_name(f".{arguments.output.name}.tmp")
    temporary.write_bytes(header + payload)
    os.chmod(temporary, 0o644)
    os.replace(temporary, arguments.output)
    print(
        f"wrote {arguments.output}: {width}x{height} at "
        f"{arguments.resolution:g} degrees, {len(header) + len(payload):,} bytes"
    )


if __name__ == "__main__":
    main()
