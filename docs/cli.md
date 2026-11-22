# The `trip` command

`scripts/trip.ts` is a thin client over the admin API, run on the machine that can reach it
(see [self-hosting.md](self-hosting.md)). `bun scripts/trip.ts --help` lists every command.

```bash
export TRIP_URL=http://127.0.0.1:8080
export TRIP_ADMIN_TOKEN=...            # or --token-file FILE
alias trip='bun /path/to/trip-diary/scripts/trip.ts'
```

## A first trip from GPX files

Record one GPX file per walking day (any app that writes `<trkpt>` with `<time>`; elevation is
optional), then:

```bash
trip new summer-walk --title "Summer walk" --timezone Europe/Berlin
trip days import-gpx summer-walk day1.gpx day2.gpx day3.gpx
trip links summer-walk
```

The files are sorted by their start time and become days 1, 2, 3 (`--first-day N` shifts the
numbering). Each day's date is the local date of its first point in the trip's timezone. The track
is thinned to about one point per 15 m; the day's distance, ascent, descent and times are computed
from the full recording. The end of the walk becomes the day's end. Re-importing a day replaces it.

`trip new` prints the view link. Open the editing host, log in, open the trip and write notes by
tapping the map; attach photos from Immich with the photo button.

## Other commands

- Trips: `ls`, `show`, `set`, `links`, `share <trip> --label L` (another view link) and
  `share <trip> --revoke ID`, `export <trip> <dir>`.
- Notes: `note <trip> [key]`, `note add`, `note set`, `note mv`, `note rm`. A note is addressed by
  its key: `7` for a numbered note, `d3` for the day-end note of day 3.
- Media: `media attach <trip> <key> <asset id or Immich photo link>`, `media suggest --day N`
  (Immich assets taken during the day), `media order`, `media rm`.
- Days as JSON: `days import <trip> days.json` takes `{"days": [...], "waypoints": [...]}` in the
  shape of the API (`DayPut`, `Waypoint` in `src/shared/api.ts`); `export` writes the same shape.
- Maps and the meeting point (when switched on): `map …`, see `--help`.

`--json` prints machine-readable output. The contract behind all of it is
[`src/shared/api.ts`](../src/shared/api.ts).
