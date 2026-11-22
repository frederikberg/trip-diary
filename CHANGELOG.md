# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The photo picker (and the admin `suggest`) also lists photos and videos from albums shared with the Immich key's user, in the same time window, pickable like the user's own, with or without GPS. It needs `album.read` on the key; without it the picker shows the user's own assets as before and the log says so once. The album list is kept for `immich.albums_minutes` (new, default 10).

## [0.14.0] - 2026-11-22

### Added

- New trips from the editor's start page ("Neue Reise"): title, slug, short title, time zone (the browser's to start with), first day and last day or an open end. The trip records its end in `extra.end_date` (a date or `open`), and the editor lands in it.
- A settings page per trip for the editor, from the start page and the trip's menu: title, short title, time zone, first and last day, ending an open trip today, the day numbering, the two privacy settings, and the read links: add one, see each, revoke one. The trip's last live link cannot be revoked there. Revoking or adding a link carries this device's drafts and waiting notes over to the link the trip opens with.
- A day offset per trip (`day_offset`, admin API and `trip new`/`trip set --day-offset`): it is added to every day number shown, so preparation and travel days before the real start read Tag 0 or Tag -1. Stored day numbers, note keys and routes stay as they are.

### Changed

- Adding a read link through the admin API moves the trip's revision, so an open editor page picks up the link to hand out.

## [0.13.1] - 2026-11-22

### Fixed

- The server keeps one built view per trip and link instead of one per revision, so a long run of writes (an import of many notes into a trip with long tracks) no longer grows its memory until it is killed.

## [0.13.0] - 2026-11-22

### Changed

- In an open note the photo count stands in the line with day, time and km instead of on the first photo, where it looked like a button hiding more.

## [0.12.0] - 2026-11-22

### Added

- A third video switch, repeat (off by default): a single video loops and several start over after the last only when it is on.
- A day made of several recordings (a ride, a train, a ride again) keeps where each one starts (`breaks` on the day). The map draws the jump between two recordings as a thin dashed line instead of a ridden one; notes never snap to it, it adds no kilometres, and the elevation profile breaks there.
- `trip days import-gpx` makes one day from the files of one date and marks the recordings: separate files, several `<trkseg>` in a file, and a pause of five minutes with a jump of a kilometre inside one.

## [0.11.0] - 2026-11-22

### Added

- Videos play inside the note: with autoplay on (the default) the note's videos start in their tiles, muted, one after another with the row scrolling along, a single one looping. Two switches above the row, autoplay and mute, are remembered per browser. The space bar plays and pauses.
- A full-screen button on each video tile. In the viewer a video starts when it comes into view, with sound, and the space bar plays and pauses it.

### Changed

- Tapping a video in a note plays it in place instead of opening the viewer. Videos in the viewer no longer preload their neighbours' metadata.

## [0.10.0] - 2026-11-22

First public release.

### Added

- `trip` command line (`scripts/trip.ts`) with `days import-gpx`: one GPX recording per day becomes a day of a trip.
- `auth.identity_header` and `auth.sign_out_path`: the login header and the sign-out path of the reverse proxy are settings, so proxies other than oauth2-proxy work.
- `maps.enabled` and `meet.enabled`: the maps of people and places and their meeting point are off by default.
- Self-hosting guide, example compose file with oauth2-proxy and Caddy, architecture and development docs.
- MIT license.
- A GitHub Release is published with each tag, with notes cut from this file.

### Changed

- The default `server.public_url`, `server.edit_url` and `immich.url` are example placeholders; the app refuses to start while the public URL or the Immich URL still holds one.
- CI and the release run on GitHub-hosted runners.
- Sample data in the tests and the browser checks is a synthetic hike.

## [0.9.0] - 2026-11-20

Photos are picked from Immich in the editor, and notes can stand without a place.

## [0.8.0] - 2026-11-14

Editing moves behind the reverse proxy's login on its own host; the app keeps no sessions.
