#!/usr/bin/env python3
"""Fetch a public Google Photos shared album and extract geotagged photos.

Queries Google Photos' per-item metadata RPC (fDcn4b) first so any location
or description set/edited in Google Photos is always preferred, and falls back
to reading EXIF GPS + ImageDescription from the original image file only when
Google Photos does not provide a location.

Usage:  pip install exifread && python3 scripts/fetch_album.py [ALBUM_URL]
"""
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import exifread

ALBUM_URL = "https://photos.app.goo.gl/jRkKPneBYiDHSSpYA"
OUT = Path(__file__).resolve().parent.parent / "data" / "photos.json"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}


def http(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.geturl(), r.read()


def load_album(url):
    final_url, body = http(url)
    html = body.decode("utf-8")
    album_id = re.search(r"/share/([^?/]+)", final_url).group(1)
    key = urllib.parse.parse_qs(urllib.parse.urlparse(final_url).query)["key"][0]
    m = re.search(r"AF_initDataCallback\(\{key: 'ds:1'.*?data:(.*?), sideChannel", html, re.S)
    data = json.loads(m.group(1))
    items, token = list(data[1]), data[2]
    title = data[3][1] if len(data) > 3 and data[3] else "Album"
    while token:
        freq = json.dumps([[["snAcKc", json.dumps([album_id, token, None, key]), None, "generic"]]])
        _, body = http(
            "https://photos.google.com/_/PhotosUi/data/batchexecute",
            data=urllib.parse.urlencode({"f.req": freq}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        )
        text = body.decode("utf-8")
        line = next(l for l in text.splitlines() if l.startswith('[["wrb.fr"'))
        page = json.loads(json.loads(line)[0][2])
        items += page[1] or []
        token = page[2] if len(page) > 2 else None
    return title, key, items


def fetch_google_photos_meta(items, key, chunk_size=50):
    """Batch-fetch per-photo metadata from Google Photos (fDcn4b RPC)."""
    meta = {}
    for start in range(0, len(items), chunk_size):
        chunk = items[start : start + chunk_size]
        batch = [["fDcn4b", json.dumps([it[0], 1, key]), None, str(idx)] for idx, it in enumerate(chunk)]
        _, body = http(
            "https://photos.google.com/_/PhotosUi/data/batchexecute",
            data=urllib.parse.urlencode({"f.req": json.dumps([batch])}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        )
        for line in body.decode("utf-8").splitlines():
            if '"wrb.fr"' not in line:
                continue
            for entry in json.loads(line):
                if entry[0] == "wrb.fr" and entry[2]:
                    info = json.loads(entry[2])[0]
                    meta[info[0]] = info
    return meta


def parse_gp_location(info):
    """Extract (lat, lng) from a Google Photos fDcn4b metadata array, or (None, None)."""
    if not info or len(info) <= 9 or not info[9] or not info[9][0]:
        return None, None
    coords = info[9][0]
    if not isinstance(coords, list) or len(coords) < 2 or coords[0] is None or coords[1] is None:
        return None, None
    lat, lng = coords[0] / 1e7, coords[1] / 1e7
    if lat == 0 and lng == 0:
        return None, None
    return lat, lng


def dms(vals, ref):
    d, m, s = (float(v.num) / float(v.den) if v.den else 0.0 for v in vals.values)
    deg = d + m / 60 + s / 3600
    return -deg if str(ref) in ("S", "W") else deg


def read_exif(base_url):
    """Download the first 128 KB of the original photo and parse EXIF GPS + description."""
    _, head = http(base_url + "=d", headers={"Range": "bytes=0-131071"})
    tags = exifread.process_file(io.BytesIO(head), details=False)
    lat = lng = None
    if "GPS GPSLatitude" in tags and "GPS GPSLongitude" in tags:
        lat = dms(tags["GPS GPSLatitude"], tags.get("GPS GPSLatitudeRef", "N"))
        lng = dms(tags["GPS GPSLongitude"], tags.get("GPS GPSLongitudeRef", "E"))
        if lat == 0 and lng == 0:
            lat = lng = None
    desc = str(tags.get("Image ImageDescription", "")).replace("\\n", "\n").strip()
    return lat, lng, desc


def build_photo(item, gp_info):
    pid, info = item[0], item[1]
    base, w, h = info[0], info[1], info[2]

    # 1. Always prefer the location from Google Photos if it exists.
    lat, lng = parse_gp_location(gp_info)
    gp_desc = (gp_info[1] or "").replace("\\n", "\n").strip() if (gp_info and len(gp_info) > 1) else ""

    # 2. Only fall back to EXIF location if Google Photos did not provide one.
    exif_desc = ""
    if lat is None or lng is None:
        exif_lat, exif_lng, exif_desc = read_exif(base)
        lat, lng = exif_lat, exif_lng

    desc = gp_desc or exif_desc
    ts = item[2]
    try:
        date = datetime(1970, 1, 1, tzinfo=timezone.utc).fromtimestamp(ts / 1000, timezone.utc).date().isoformat()
    except Exception:
        date = None
    return {
        "id": pid,
        "url": base,
        "width": w,
        "height": h,
        "lat": lat,
        "lng": lng,
        "description": desc,
        "date": date,
    }


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ALBUM_URL
    title, key, items = load_album(url)
    print(f"Album '{title}': {len(items)} items")
    gp_meta = fetch_google_photos_meta(items, key)
    with ThreadPoolExecutor(12) as ex:
        photos = list(ex.map(lambda it: build_photo(it, gp_meta.get(it[0])), items))
    geo = [p for p in photos if p["lat"] is not None and p["lng"] is not None]
    print(f"{len(geo)} of {len(photos)} photos have GPS coordinates")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"album": title, "albumUrl": url, "total": len(photos), "photos": geo}, indent=1))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
