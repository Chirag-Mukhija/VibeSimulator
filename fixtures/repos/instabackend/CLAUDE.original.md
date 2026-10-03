# instaBackend

A production-quality Instagram-like backend built for learning backend engineering
depth — auth, file storage, social graphs, feed generation, and pagination at scale.
This is a **learning project**: prioritize correctness and clarity over cleverness.
Do not add abstractions, libraries, or infrastructure beyond what a given task
actually needs.

Stack: Node.js + Express + PostgreSQL + Redis + AWS S3 + Docker/Nginx.

## Status

All 7 planned phases are built, live-verified (against real Postgres/Redis, and
Phase 7 against a real `docker compose` stack), and documented. There is no
unfinished or half-built code in `src/`.

| Phase | What it added | Theory doc |
|---|---|---|
| 1 | Auth: JWT access+refresh, register/login/logout, Redis-backed revocable sessions | `docs/phase-1-theory.pdf` |
| 2 | Profiles + S3 presigned-upload flow + posts | `docs/phase-2-theory.pdf` |
| 3 | Follow/unfollow (social graph) | `docs/phase-3-theory.pdf` |
| 4 | Feed generation — fan-out-on-write AND fan-out-on-read, both exposed | `docs/phase-4-theory.pdf` |
| 5 | Likes, comments, notifications (poll-based, no websockets) | `docs/phase-5-theory.pdf` |
| 6 | Cursor (keyset) pagination everywhere, search, explore | `docs/phase-6-theory.pdf` |
| 7 | Docker, Nginx, two-layer rate limiting, helmet, morgan, graceful shutdown | `docs/phase-7-theory.pdf` |

**Read the relevant phase's theory PDF before making non-trivial changes in that
area.** Each PDF explains *why* the code is shaped the way it is — architecture,
data model reasoning, known limitations, and the decisions log — in far more depth
than inline comments do. The theory docs are the primary design documentation for
this project; the code intentionally carries almost no comments (see Code Style
below), so context lives in the PDFs, not in the source.

## Architecture

Strict layering, enforced by convention (not by tooling):

```
routes/       — wires HTTP verb+path to a controller function, nothing else
controllers/  — parses req, calls service(s), shapes the response. No SQL, no JWT,
                no AWS SDK calls here, ever.
services/     — all business logic and all DB/Redis/S3 access. One service owns
                one table (e.g. post.service.js only ever queries `posts`).
                Cross-table orchestration (e.g. "create a post AND fan it out to
                followers") lives in a dedicated orchestrating service
                (feed.service.js), not scattered across controllers — unless it's
                a simple two-call sequence, in which case the controller may call
                two services directly (see follow.controller.js notifying after
                following).
middlewares/  — auth guard, error handler, rate limiter
utils/        — jwt signing, password hashing, pagination cursor encode/decode,
                asyncHandler wrapper
config/       — env loading/validation, DB pool, Redis client, S3 client
db/migrations/ — plain numbered .sql files, applied in order by db/migrate.js
```

Every route handler is wrapped in `utils/asyncHandler.js` so a rejected promise
reaches `middlewares/error.middleware.js` instead of crashing the process. Thrown
errors that carry a `.statusCode` (e.g. `AuthError`, `FollowError`, `ProfileError`,
`UploadError`) get turned into the matching HTTP status by that one error handler.

## Established conventions (follow these for any new code)

- **Composite primary keys for pure join tables** (`follows`, `likes`,
  `feed_items`): `(a_id, b_id)` as the PK, no synthetic `id` column, and
  `ON CONFLICT (a_id, b_id) DO NOTHING` for idempotent writes. Reserve a real UUID
  `id` column for rows that have independent identity beyond the pair (e.g.
  `comments`, `notifications`).
- **Live `COUNT(*)` over denormalized counters** for anything read far less often
  than a naive counter-column would need updating at this project's scale (post
  counts, follower/following counts, like/comment counts). This is a deliberate,
  repeated choice — see each phase's Decisions Log for the reasoning and the point
  at which it should be revisited.
- **Cursor (keyset) pagination for any new listing endpoint** — never `OFFSET`.
  Use `utils/pagination.js`'s `encodeCursor`/`decodeCursor`/`parseLimit`. The
  pattern: `WHERE (sort_col, tiebreaker) < ($cursor) ORDER BY sort_col DESC,
  tiebreaker DESC LIMIT $limit`, and `nextCursor = rows.length === limit ?
  encodeCursor(last.sort_col, last.tiebreaker) : null`. Direction (DESC/`<` vs
  ASC/`>`) should match how that specific list is meant to be read (see Phase 6
  theory doc, Section 3.6).
- **Idempotent writes return whether they actually did something.** `follow()` and
  `like()` return a boolean (`rowCount > 0`) so callers can tell a genuinely new
  action from a harmless repeat — this matters for not firing duplicate
  notifications (a real bug this project hit and fixed during Phase 5; see that
  phase's theory doc).
- **Notifications are only ever created from inside the controller performing the
  underlying action**, never from a standalone endpoint, and only when
  `recipientId !== actorId` and the action was newly created (see above). Follow
  this exact pattern for any new notification-producing action.
- **S3 objects are never touched by the app server** — only presigned URLs are
  issued (`upload.service.js`). Any code accepting a client-submitted URL for an
  image (post `imageUrl`, profile `avatarUrl`) must validate it with
  `uploadService.isOwnedPublicUrl` before writing it to the database.

## Code style

- No inline explanatory comments. A one-line responsibility comment at the top of
  each file. Comments only where a genuinely non-obvious decision was made (why,
  not what).
- Async/await throughout, no callbacks.
- All DB access through the services layer — never in controllers.
- JWT logic stays isolated in `utils/jwt.js` — never call `jsonwebtoken` directly
  elsewhere.

## Running locally

```
cp .env.example .env   # fill in real values — DATABASE_URL/REDIS_URL for local
                        # Postgres+Redis, any values work for AWS_* since presigning
                        # is pure local computation and needs no real AWS account
                        # to exercise the code path
npm install
npm run migrate
npm run dev             # nodemon
```

Or the full containerized stack: `docker compose up -d --build`, then
`docker exec <app-container> node src/db/migrate.js` once, then hit it on
`localhost:80`.

## Verification pattern used throughout this project

Every phase so far was verified live with real running Postgres/Redis (curl-based
flows exercising success cases, error cases, auth boundaries, and idempotency) —
not just unit tests in isolation, and not just "it compiles." Continue that pattern
for any new work: boot the app against real local services and actually hit the
new endpoints before considering a change done.
