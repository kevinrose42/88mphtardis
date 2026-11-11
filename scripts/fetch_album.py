#!/usr/bin/env python3
"""Fetch a public Google Photos shared album and extract geotagged photos.

Reads the album's embedded data (plus paginated batchexecute calls), downloads
the first chunk of each original file to parse EXIF GPS + ImageDescription,
and writes data/photos.json for the map site.

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
    return title, items


def dms(vals, ref):
    d, m, s = (float(v.num) / float(v.den) if v.den else 0.0 for v in vals.values)
    deg = d + m / 60 + s / 3600
    return -deg if str(ref) in ("S", "W") else deg


def read_meta(item):
    pid, info = item[0], item[1]
    base, w, h = info[0], info[1], info[2]
    _, head = http(base + "=d", headers={"Range": "bytes=0-131071"})
    tags = exifread.process_file(io.BytesIO(head), details=False)
    lat = lng = None
    if "GPS GPSLatitude" in tags and "GPS GPSLongitude" in tags:
        lat = dms(tags["GPS GPSLatitude"], tags.get("GPS GPSLatitudeRef", "N"))
        lng = dms(tags["GPS GPSLongitude"], tags.get("GPS GPSLongitudeRef", "E"))
    desc = str(tags.get("Image ImageDescription", "")).replace("\\n", "\n").strip()
    ts = item[2]
    try:
        date = datetime(1970, 1, 1, tzinfo=timezone.utc).fromtimestamp(ts / 1000, timezone.utc).date().isoformat()
    except Exception:
        date = None
    return {"id": pid, "url": base, "width": w, "height": h, "lat": lat, "lng": lng,
            "description": desc, "date": date}


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ALBUM_URL
    title, items = load_album(url)
    print(f"Album '{title}': {len(items)} items")
    with ThreadPoolExecutor(12) as ex:
        photos = list(ex.map(read_meta, items))
    geo = [p for p in photos if p["lat"] is not None and not (p["lat"] == 0 and p["lng"] == 0)]
    print(f"{len(geo)} of {len(photos)} photos have GPS coordinates")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"album": title, "albumUrl": url, "total": len(photos), "photos": geo}, indent=1))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
