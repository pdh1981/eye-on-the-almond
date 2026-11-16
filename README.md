# Eye on the Almond (tester site)

A test version of Eye on the Almond, the River Almond digital twin, for a small
group of testers. This repository holds only the built website and a job that
collects Scottish Water's open overflow data; the source code is kept
elsewhere.

- **Sensor data (Forth-ERA, MOT4Rivers)** comes from SIEC and is shown only to
  people who sign in with their own SIEC account (top of the map, "Sign in for
  sensor data"). Nothing from SIEC is stored in this repository.
- **Sewer overflows** are read from Scottish Water's open near-real-time feed
  every 15 minutes by `.github/workflows/overflows.yml`, which keeps a spill
  log in `data/live/`. Counts are complete only from the date the log started.
- SEPA rainfall, river levels, flood maps and classification are read live
  from SEPA's open services.

Published with GitHub Pages (Settings > Pages > Deploy from a branch > main, / (root)).
