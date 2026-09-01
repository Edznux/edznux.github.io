#!/usr/bin/env python3
"""Build static/data/atlas-data.js for the ASCII bikepacking map (/map/).

Inputs (downloaded on first run, cached in scripts/atlas/cache/):
  - the activity collection export from activities.edznux.fr
  - Natural Earth 50m land / lakes / country borders (public domain)

Output: a single JS file defining window.ATLAS_DATA with
  - a coarse "coverage" grid (0..15) of land and borders, already projected
    (Lambert conformal conic centred on Europe), run-length encoded
  - every ride's polyline decoded, projected into the same grid space and
    simplified, plus its metadata
  - a handful of city labels in grid space

Everything geographic happens here so the browser only ever deals with
grid coordinates and never has to know about projections.

Usage: python3 scripts/atlas/build-data.py [--refresh]
"""

import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(ROOT, "static", "data", "atlas-data.js")

COLLECTION = "087766ae-c2fe-4552-afcb-5b638995c064"
EXPORT_URL = f"https://activities.edznux.fr/api/groups/{COLLECTION}/export.json"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
NE_FILES = {
    "land": "ne_50m_land.geojson",
    "lakes": "ne_50m_lakes.geojson",
    "borders": "ne_50m_admin_0_boundary_lines_land.geojson",
}

# Coverage grid (in "grid pixels"). Aspect 3:2 matches a ~0.6 char width
# ratio nicely once the browser picks its column/row counts.
GW, GH = 480, 320
OVERSAMPLE = 4  # rasterise at 4x then average down for anti-aliased coverage

# Lambert conformal conic, spherical form. Standard parallels chosen so that
# both the Alps and Nordkapp look reasonable.
PHI1, PHI2 = math.radians(43), math.radians(62)
LON0, LAT0 = math.radians(12), math.radians(54)
_n = math.log(math.cos(PHI1) / math.cos(PHI2)) / math.log(
    math.tan(math.pi / 4 + PHI2 / 2) / math.tan(math.pi / 4 + PHI1 / 2))
_F = math.cos(PHI1) * math.tan(math.pi / 4 + PHI1 / 2) ** _n / _n
_rho0 = _F / math.tan(math.pi / 4 + LAT0 / 2) ** _n


def project(lon, lat):
    """lon/lat degrees -> (x, y) in projection units, y up."""
    lam, phi = math.radians(lon), math.radians(lat)
    rho = _F / math.tan(math.pi / 4 + phi / 2) ** _n
    t = _n * (lam - LON0)
    return rho * math.sin(t), _rho0 - rho * math.cos(t)


# The visible frame in projection units. Built from a few anchor points so
# the routes (6..26E, 46..71N) sit right of centre with Europe as context.
def compute_frame():
    anchors = [(-13, 36), (-24, 63.5), (-2, 73.5), (28, 73.5), (30, 45), (25, 35.5)]
    xs, ys = zip(*(project(*a) for a in anchors))
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    # pad to the grid aspect
    w, h = x1 - x0, y1 - y0
    if w / h < GW / GH:
        extra = h * GW / GH - w
        x0 -= extra / 2
        x1 += extra / 2
    else:
        extra = w * GH / GW - h
        y0 -= extra / 2
        y1 += extra / 2
    return x0, x1, y0, y1


FX0, FX1, FY0, FY1 = compute_frame()


def to_grid(lon, lat, scale=1):
    """lon/lat -> grid pixel coords (x right, y down), optionally oversampled."""
    x, y = project(lon, lat)
    gx = (x - FX0) / (FX1 - FX0) * GW * scale
    gy = (FY1 - y) / (FY1 - FY0) * GH * scale
    return gx, gy


def fetch(url, name, refresh=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if refresh or not os.path.exists(path):
        print(f"fetching {url}")
        with urllib.request.urlopen(url, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, "rb") as f:
        return json.load(f)


# ---- geometry helpers -------------------------------------------------------

def rings_of(geom):
    """Yield (exterior, holes) per polygon of a (Multi)Polygon."""
    if geom["type"] == "Polygon":
        yield geom["coordinates"][0], geom["coordinates"][1:]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield poly[0], poly[1:]


def lines_of(geom):
    if geom["type"] == "LineString":
        yield geom["coordinates"]
    elif geom["type"] == "MultiLineString":
        yield from geom["coordinates"]


def bbox_hits(coords, lon_min=-45, lon_max=70, lat_min=20, lat_max=85):
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return not (max(lons) < lon_min or min(lons) > lon_max
                or max(lats) < lat_min or min(lats) > lat_max)


def rasterise(land, lakes, borders):
    W, H = GW * OVERSAMPLE, GH * OVERSAMPLE
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    for feat in land["features"]:
        for ext, holes in rings_of(feat["geometry"]):
            if not bbox_hits(ext):
                continue
            d.polygon([to_grid(lo, la, OVERSAMPLE) for lo, la in ext], fill=255)
            for hole in holes:
                d.polygon([to_grid(lo, la, OVERSAMPLE) for lo, la in hole], fill=0)
    for feat in lakes["features"]:
        # only the big ones; small lakes are noise at this resolution
        if feat["properties"].get("scalerank", 9) > 3:
            continue
        for ext, _ in rings_of(feat["geometry"]):
            if not bbox_hits(ext):
                continue
            d.polygon([to_grid(lo, la, OVERSAMPLE) for lo, la in ext], fill=0)

    bimg = Image.new("L", (W, H), 0)
    bd = ImageDraw.Draw(bimg)
    for feat in borders["features"]:
        for line in lines_of(feat["geometry"]):
            if not bbox_hits(line):
                continue
            bd.line([to_grid(lo, la, OVERSAMPLE) for lo, la in line], fill=255, width=2)

    def down(im):
        a = np.asarray(im, dtype=np.float32) / 255.0
        a = a.reshape(GH, OVERSAMPLE, GW, OVERSAMPLE).mean(axis=(1, 3))
        return np.clip(np.round(a * 15), 0, 15).astype(np.uint8)

    return down(img), down(bimg)


def rle(grid):
    """Flatten row-major and run-length encode as [value, count, value, count...]."""
    flat = grid.reshape(-1)
    out = []
    cur, n = int(flat[0]), 0
    for v in flat:
        v = int(v)
        if v == cur:
            n += 1
        else:
            out.extend((cur, n))
            cur, n = v, 1
    out.extend((cur, n))
    return out


# ---- routes -----------------------------------------------------------------

def decode_polyline(s):
    idx, lat, lng, out = 0, 0, 0, []
    while idx < len(s):
        for j in range(2):
            shift = res = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            dl = ~(res >> 1) if res & 1 else res >> 1
            if j == 0:
                lat += dl
            else:
                lng += dl
        out.append((lat / 1e5, lng / 1e5))
    return out


def simplify(points, tol):
    """Douglas-Peucker on (x, y) tuples."""
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = math.hypot(dx, dy) or 1e-9
    best, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        dist = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / norm
        if dist > best:
            best, idx = dist, i
    if best > tol:
        return simplify(points[: idx + 1], tol)[:-1] + simplify(points[idx:], tol)
    return [points[0], points[-1]]


# Trips = clusters of rides separated by more than 30 days. Names are hand
# written here because the export has no notion of a trip. "end_date" pins
# the end marker/label to the last ride of that day instead of the trip's
# very last ride (2024 had three extra gravel days after reaching Wien).
TRIP_NAMES = {
    2023: {"title": "To the very north", "from": "København", "to": "Nordkapp",
           "post": "/posts/cycling-to-the-very-north/"},
    2024: {"title": "Alps to the Danube", "from": "Annecy", "to": "Wien",
           "end_date": "2024-07-12"},
    2025: {"title": "Up to Danmark", "from": "Annecy", "to": "København"},
}

CITIES = [
    # name, lon, lat, importance (1 = always drawn, 2 = only when there's
    # room), label side ("r" default, "l" = left of the marker).
    # Nordkapp / Wien are not here: the trip end labels already name them.
    ("Oslo", 10.75, 59.91, 1, "r"),
    ("Stockholm", 18.07, 59.33, 1, "r"),
    ("Helsinki", 24.94, 60.17, 2, "r"),
    ("København", 12.57, 55.68, 1, "r"),
    ("Berlin", 13.40, 52.52, 1, "r"),
    ("Neuchâtel", 6.93, 46.99, 1, "l"),
    ("Annecy", 6.13, 45.90, 1, "l"),
    ("Paris", 2.35, 48.86, 1, "l"),
    ("London", -0.13, 51.51, 2, "l"),
    ("Madrid", -3.70, 40.42, 2, "r"),
    ("Roma", 12.50, 41.90, 2, "r"),
    ("Warszawa", 21.01, 52.23, 2, "r"),
    ("Reykjavík", -21.94, 64.15, 2, "r"),
]


def main():
    refresh = "--refresh" in sys.argv
    export = fetch(EXPORT_URL, "export.json", refresh)
    land = fetch(NE + NE_FILES["land"], NE_FILES["land"], refresh)
    lakes = fetch(NE + NE_FILES["lakes"], NE_FILES["lakes"], refresh)
    borders = fetch(NE + NE_FILES["borders"], NE_FILES["borders"], refresh)

    print("rasterising…")
    land_grid, border_grid = rasterise(land, lakes, borders)

    rides = []
    for a in sorted(export["activities"], key=lambda a: (a["date"], a["id"])):
        if not a.get("polyline"):
            continue
        pts = [to_grid(lo, la) for la, lo in decode_polyline(a["polyline"])]
        pts = simplify(pts, 0.3)
        rides.append({
            "id": a["id"],
            "name": a["name"],
            "date": a["date"],
            "km": round(a["distance"] / 1000, 1),
            "elev": int(a.get("elevGain") or 0),
            "secs": int(a.get("movingTime") or 0),
            "pts": [[round(x, 1), round(y, 1)] for x, y in pts],
        })

    # group into trips by date gap
    trips = []
    from datetime import date
    prev = None
    for i, r in enumerate(rides):
        d = date.fromisoformat(r["date"])
        if prev is None or (d - prev).days > 30:
            trips.append({"rides": []})
        trips[-1]["rides"].append(i)
        prev = d
    for t in trips:
        rs = [rides[i] for i in t["rides"]]
        year = int(rs[0]["date"][:4])
        info = TRIP_NAMES.get(year, {})
        days = len({r["date"] for r in rs})
        end_ride = rs[-1]
        if info.get("end_date"):
            end_ride = [r for r in rs if r["date"] == info["end_date"]][-1]
        t.update({
            "year": year,
            "title": info.get("title", str(year)),
            "from": info.get("from", ""),
            "to": info.get("to", ""),
            "post": info.get("post"),
            "start": rs[0]["date"],
            "end": rs[-1]["date"],
            "startPt": rs[0]["pts"][0],
            "endPt": end_ride["pts"][-1],
            "endRide": rides.index(end_ride),
            "days": days,
            "km": round(sum(r["km"] for r in rs)),
            "elev": sum(r["elev"] for r in rs),
            "secs": sum(r["secs"] for r in rs),
        })
        for i in t["rides"]:
            rides[i]["trip"] = trips.index(t)

    # graticule: every 10 degrees, as simplified grid-space polylines
    grat = []
    for lat in range(30, 81, 10):
        grat.append(simplify([to_grid(lon, lat) for lon in range(-40, 71)], 0.3))
    for lon in range(-40, 71, 10):
        grat.append(simplify([to_grid(lon, lat) for lat in range(25, 85)], 0.3))
    grat = [[[round(x, 1), round(y, 1)] for x, y in line] for line in grat]

    cities = [{"name": n, "x": round(to_grid(lo, la)[0], 1), "y": round(to_grid(lo, la)[1], 1),
               "p": p, "side": side} for n, lo, la, p, side in CITIES]

    data = {
        "gw": GW, "gh": GH,
        "land": rle(land_grid),
        "borders": rle(border_grid),
        "rides": rides,
        "trips": trips,
        "cities": cities,
        "grat": grat,
        "collection": export["name"],
        "stats": export.get("stats", []),
        "source": f"https://activities.edznux.fr/embed/{COLLECTION}",
    }
    js = ("// Generated by scripts/atlas/build-data.py — do not edit by hand.\n"
          "// Coastlines: Natural Earth (public domain). Rides: activities.edznux.fr\n"
          "window.ATLAS_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"wrote {OUT}: {len(js)/1024:.0f} KB, {len(rides)} rides, {len(trips)} trips, "
          f"land runs={len(data['land'])//2}, border runs={len(data['borders'])//2}")
    if "--png" in sys.argv:
        # debug preview: land grey, borders dark, rides green, cities red
        rgb = np.zeros((GH, GW, 3), dtype=np.uint8)
        rgb[..., :] = (land_grid[..., None].astype(np.uint16) * 10).astype(np.uint8)
        rgb[border_grid > 4] = (60, 60, 60)
        for r in rides:
            for x, y in r["pts"]:
                if 0 <= x < GW and 0 <= y < GH:
                    rgb[int(y), int(x)] = (120, 226, 160)
        for c in cities:
            x, y = int(c["x"]), int(c["y"])
            if 0 <= x < GW and 0 <= y < GH:
                rgb[max(0, y-1):y+2, max(0, x-1):x+2] = (255, 60, 60)
        png = os.path.join(CACHE, "preview.png")
        Image.fromarray(rgb).resize((GW * 2, GH * 2), Image.NEAREST).save(png)
        print("preview:", png)


if __name__ == "__main__":
    main()
