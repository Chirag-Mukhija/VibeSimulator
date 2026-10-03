# Blind samples

Third-party repos labeled from their source **before** the extractor was run on
them. Only the flows listed under `scope` are scored. Run with:

    pnpm --filter @vibesim/extractor eval:blind

Once a miss is fixed the sample is no longer blind, so the first-run numbers are
the honest generalization measure. Keep this table append-only.

| Repo | Commit | First run (precision / recall) | Missed on first run | After fixes |
|---|---|---|---|---|
| bradtraversy/proshop-v2 | e23e3a8 | 100% / 81.3% | Mongoose documents (`new Model().save()`, `doc.save()`), schema methods (`user.matchPassword`), fetch with an env-var base URL | 100% / 100% |
| sahat/hackathon-starter | d390f81 | 100% / 93.2% | express-session MongoStore reads, passport `deserializeUser` per request | 100% / 100% |

To add a sample: pick a repo nobody has run the extractor on, write
`<name>.truth.txt` with a `repo <url> <commit>` line and a few `scope` flows, and
commit the truth file before the first run.
