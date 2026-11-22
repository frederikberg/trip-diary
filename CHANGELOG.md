# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
