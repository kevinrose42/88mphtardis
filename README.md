# 88mphtardis – Photo Map

A static website that shows every geotagged photo from the public Google Photos
album [MenloPark](https://photos.app.goo.gl/jRkKPneBYiDHSSpYA) as a pin on a
Google Map. Click a pin to see the photo and its caption. Click the photo to open
it full size. Pins that share a location show a count badge and have Prev/Next
buttons. Nearby pins are grouped into clusters when you zoom out.

## Setup

1. Get a Google Maps JavaScript API key
   (https://console.cloud.google.com/google/maps-apis/credentials). Enable the
   **Maps JavaScript API**, and restrict the key to your site's domain.
2. Put the key in [`config.js`](config.js).
3. Serve the folder with any static host (GitHub Pages works). To run it locally:

   ```sh
   python3 -m http.server 8000   # then open http://localhost:8000
   ```

## Refreshing the photo data

`data/photos.json` is created by a script that reads the shared album and parses
the EXIF GPS coordinates and description from each original photo:

```sh
pip install exifread
python3 scripts/fetch_album.py            # or pass a different album URL
```

Run the script again after you add photos to the album.