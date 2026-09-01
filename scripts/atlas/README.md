# atlas

Generates `static/data/atlas-data.js`, the pre-projected data behind the
ASCII map at `/map/` (`layouts/_default/atlas.html`, `static/js/atlas.js`,
`static/css/atlas.css`).

```sh
python3 scripts/atlas/build-data.py            # uses cached downloads
python3 scripts/atlas/build-data.py --refresh  # re-download rides + Natural Earth
python3 scripts/atlas/build-data.py --png      # also write cache/preview.png
```

Needs `numpy` and `Pillow`. Downloads are cached in `cache/` (gitignored).
When a new trip is added, give it a name in `TRIP_NAMES` inside the script
and commit the regenerated data file.
