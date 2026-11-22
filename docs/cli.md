# The `trip` command

`scripts/trip.ts` is a thin client over the admin API, run on the machine that can reach it
(see [self-hosting.md](self-hosting.md)). `bun scripts/trip.ts --help` lists every command.

```bash
export TRIP_URL=http://127.0.0.1:8080
export TRIP_ADMIN_TOKEN=...            # or --token-file FILE
alias trip='bun /path/to/trip-diary/scripts/trip.ts'
```

## A first trip from GPX files

Record the GPX files of the walk (any app that writes `<trkpt>` with `<time>`; elevation is
optional), then:

```bash
trip new summer-walk --title "Summer walk" --timezone Europe/Berlin
trip days import-gpx summer-walk day1.gpx day2.gpx day3.gpx
trip links summer-walk
```

The files are sorted by their start time and become days 1, 2, 3 (`--first-day N` shifts the
numbering). Each day's date is the local date of its first point in the trip's timezone; files
starting on the same date are one day. The track is thinned to about one point per 15 m; the day's
distance, ascent, descent and times are computed from the full recordings. The end of the walk
becomes the day's end. Re-importing a day replaces it.

A day made of several recordings (a ride, a train, a ride again) keeps where each one starts in
`breaks`: files of one date, several `<trkseg>` in one file, and a pause of five minutes or more
with a jump of a kilometre or more inside one segment each start a new recording. The map draws
the stretch between two recordings as a thin dashed line. It adds nothing to the distance and no
note snaps to it.

`trip new` prints the view link. Open the editing host, log in, open the trip and write notes by
tapping the map; attach photos from Immich with the photo button.

## Other commands

- Trips: `ls`, `show`, `set`, `links`, `share <trip> --label L` (another view link) and
  `share <trip> --revoke ID`, `export <trip> <dir>`. `new` and `set` take `--day-offset N`: it is
  added to every day number the app shows (-1 shows day 1 as Tag 0). The CLI addresses days and
  day-end notes by their stored number (`d3`, `--day 3`); `show` adds the shown one, `day 1 (Tag 0)`.
- The editor can do most of this in the browser too: a new trip from the start page on the editing
  host, and a trip's title, dates, time zone, day numbers, privacy and read links on its settings
  page.
- Notes: `note <trip> [key]`, `note add`, `note set`, `note mv`, `note rm`. A note is addressed by
  its key: `7` for a numbered note, `d3` for the day-end note of day 3.
- Media: `media attach <trip> <key> <asset id or Immich photo link>`, `media suggest --day N`
  (Immich assets taken during the day), `media order`, `media rm`.
- Days as JSON: `days import <trip> days.json` takes `{"days": [...], "waypoints": [...]}` in the
  shape of the API (`DayPut`, `Waypoint` in `src/shared/api.ts`); `export` writes the same shape.
  A day's optional `breaks` lists the indices into `track` where a new recording starts, e.g. a
  track of 300 points with `"breaks": [120, 210]` is three recordings (points 0-119, 120-209,
  210-299); each index is an integer between 1 and `track.length - 1`, strictly increasing. Omit
  it for a day of one recording.
- Maps and the meeting point (when switched on): `map …`, see `--help`.

`--json` prints machine-readable output. The contract behind all of it is
[`src/shared/api.ts`](../src/shared/api.ts).
