import type { LearnPage } from "../pages.ts";

/** Learn pages for the data concepts: pagination, indexes, read replicas, sharding and transactions. */
export const dataPages: LearnPage[] = [
  {
    concept: "pagination",
    problem: "A feed endpoint that returns every row works on day one with 50 posts. With half a million, each request reads them all, builds a huge JSON response and makes the browser render it. Returning one page at a time keeps each request small, and how you ask for the next page decides whether deep pages stay fast.",
    how: [
      "OFFSET pagination asks for page N with LIMIT 20 OFFSET 20 × (N − 1). It is easy and lets you jump to any page number. But the database can't jump to row 10,000: it walks past every skipped row, even with an index, and throws them away. Page 500 reads 10,000 rows to return 20, so the deeper the page, the slower it gets.",
      "OFFSET counts positions, and positions move. When a new post arrives while someone is reading, every older post shifts down one place, so the next page starts with a post they already saw. A deleted post shifts things the other way, and one is skipped.",
      "A cursor (keyset pagination) remembers where the last page ended instead: the created_at and id of its last post. The next query asks for posts older than that, WHERE (created_at, id) < (…), with ORDER BY and LIMIT. With an index on (created_at, id), the database goes straight to that spot, so page 500 costs about the same as page 1, and new posts above the cursor change nothing. The id breaks ties between posts with the same timestamp.",
    ],
    code: { caption: "GET /feed?after=… with a cursor, using node-postgres:", text: "const [at, id] = req.query.after ? decodeCursor(req.query.after) : [new Date('9999-01-01'), 0];\nconst { rows } = await pool.query(\n  `SELECT id, created_at, body FROM posts\n   WHERE (created_at, id) < ($1, $2)\n   ORDER BY created_at DESC, id DESC LIMIT 20`, [at, id]);\nconst last = rows.at(-1);\nres.json({ posts: rows, next: last ? encodeCursor(last.created_at, last.id) : null });" },
    breaks: [
      "A cursor can't jump to page 37; it only moves to the next (or previous) page. Fine for feeds and infinite scroll, awkward for numbered page links.",
      "The sort must be on columns that are unique together (add the id) and covered by an index, or the database sorts the whole table for every page anyway.",
      "Showing a total (\"1,234 results\") with count(*) reads every matching row too; show \"more\" or an estimate instead.",
      "OFFSET is fine for small tables and the first few pages. Its cost shows up with depth.",
    ],
  },
  {
    concept: "database-index",
    problem: "Looking up one user's orders is instant in development, where the table has 200 rows. In production, with millions of orders, the same query can take seconds, because without an index the database has no way to find the rows except reading all of them.",
    how: [
      "Without an index, WHERE user_id = 42 means a sequential scan: read every row, check its user_id, keep the matches. The cost grows with the table, not with the result. Finding 5 orders among 10 million rows reads 10 million rows.",
      "An index is a separate, sorted structure, by default a B-tree: user ids in order, each pointing to where its rows sit in the table. To find user 42, the database starts at the root, follows a few levels down to the leaf holding 42, then fetches just those rows. Each page of the tree holds hundreds of entries, so even millions of rows need only 3 or 4 levels.",
      "The index isn't free. Every INSERT also adds an entry at its sorted place, and updates and deletes must keep it in step, for each index on the table. It takes disk space and memory too. Index the columns your queries filter, join or sort by, not every column.",
      "EXPLAIN ANALYZE shows which one you got: \"Seq Scan on orders\" or \"Index Scan using orders_user_id_idx\".",
    ],
    code: { caption: "Add the index once (CONCURRENTLY doesn't block writes while it builds); the query stays the same:", text: "// a migration, run once\nawait pool.query('CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id)');\n\n// the route it speeds up\napp.get('/users/:id/orders', async (req, res) => {\n  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id = $1', [req.params.id]);\n  res.json(rows);\n});" },
    breaks: [
      "Write-heavy tables: every extra index adds work to each insert and grows the space the table takes.",
      "Queries a plain index can't serve: a function on the column (WHERE lower(email) = …) or a leading wildcard (LIKE '%son').",
      "An index on (user_id, created_at) serves queries on user_id, but helps little for created_at alone. Column order matters.",
      "On a small table the planner may still pick a sequential scan, because reading everything is cheaper than jumping around. That's correct, not a bug.",
    ],
  },
  {
    concept: "read-replica",
    problem: "Most apps read far more than they write: feeds, profiles, search. When one database is busy with reads, writes wait behind them. Read replicas are copies of the database that take the reads, so the primary can focus on the writes.",
    how: [
      "The primary takes every write. It records each change in its write-ahead log and streams that to the replicas, which replay it to stay identical. Your app sends INSERT, UPDATE and DELETE to the primary and SELECTs to a replica.",
      "Streaming is usually asynchronous: the primary confirms a write without waiting for the replicas. So each replica is a little behind, called replication lag: usually milliseconds, sometimes seconds when a replica is busy or far away. A user who posts and reloads at once can land on a replica that hasn't applied the post yet, and it looks lost.",
      "The usual fix is reading your own writes: for a few seconds after a user writes, send that user's reads to the primary. Everyone else keeps reading from replicas.",
      "Replicas add read capacity, not write capacity: every replica replays every write, and the primary still does them all.",
    ],
    code: { caption: "Two pools, and the reads right after a write go to the primary:", text: "const primary = new Pool({ connectionString: process.env.PRIMARY_URL });\nconst replica = new Pool({ connectionString: process.env.REPLICA_URL });\n\napp.post('/posts', async (req, res) => {\n  await primary.query('INSERT INTO posts (user_id, body) VALUES ($1, $2)', [req.user.id, req.body.text]);\n  req.session.wroteAt = Date.now();\n  res.status(201).end();\n});\n\napp.get('/feed', async (req, res) => {\n  const db = Date.now() - (req.session.wroteAt ?? 0) < 5000 ? primary : replica;\n  res.json((await db.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 20')).rows);\n});" },
    breaks: [
      "Lag spikes (a long query on the replica, a big migration, a slow network) leave a replica seconds or minutes behind. Monitor it.",
      "Code that writes and then reads in the same request must read from the primary.",
      "Too many writes: replicas don't help. That needs fewer or batched writes, or sharding.",
      "If the primary dies, promoting a replica can lose the last writes it hadn't received yet.",
    ],
  },
  {
    concept: "sharding",
    problem: "One database server has one machine's worth of disk, memory and write capacity. When the data or the writes outgrow the biggest machine you can get, replicas don't help: each one still holds everything and replays every write. Sharding splits the data itself across several databases.",
    how: [
      "Pick a shard key, such as user_id, and a rule that maps each key to one shard: hash(user_id) % N, or a table of ranges. All of one user's rows live on one shard, so a query for that user goes to that shard alone, and each shard stores and writes only its part.",
      "A query without the shard key (\"all orders over $100 today\") can't be routed. The app must ask every shard and merge the results, waiting for the slowest. Joins and transactions across shards are hard or impossible, so choose the key most queries already filter by.",
      "A hot key defeats the split. If one very popular account gets most of the traffic, its shard is overloaded however many shards there are, because one key always maps to one shard.",
      "With plain modulo, changing N moves most keys: going from 3 shards to 4 changes the shard of about three users in four. Consistent hashing, or many small logical shards spread over a few servers, keeps the moves small.",
    ],
    code: { caption: "The app routes each query by key:", text: "const shards = [pg0, pg1, pg2];                     // one pool per database\nconst shardFor = (userId) => shards[hash(String(userId)) % shards.length];\n\napp.get('/users/:id/orders', async (req, res) => {\n  const db = shardFor(req.params.id);                // exactly one shard\n  res.json((await db.query('SELECT * FROM orders WHERE user_id = $1', [req.params.id])).rows);\n});" },
    breaks: [
      "Reports and searches across all users: every shard does the work, and the slowest one sets the time.",
      "Hot keys: one popular key overloads one shard.",
      "Adding shards means copying data between databases while the app keeps running.",
      "Unique constraints, joins and transactions only work within one shard. Shard only when one machine truly can't keep up.",
    ],
  },
  {
    concept: "transactions",
    problem: "A money transfer is two writes: take $100 from Alice, give $100 to Bob. If the app crashes, a deploy restarts it, or the second query fails after the first one ran, Alice has lost $100 that never reached Bob. A transaction makes the two writes succeed or fail together.",
    how: [
      "Between BEGIN and COMMIT, the database keeps your changes without making them final. COMMIT makes them all permanent at once; ROLLBACK throws them all away. If the connection drops before COMMIT, because the app crashed, the database rolls back by itself.",
      "Other connections don't see uncommitted changes, so nobody reads the moment where Alice was debited and Bob not yet credited. Without a transaction, each statement is saved on its own the moment it runs, and anyone can read in between.",
      "A transaction belongs to one database connection. With a node-postgres pool, check out a client with pool.connect() and run every statement on it. Separate pool.query() calls can each get a different connection, so the BEGIN may not cover the UPDATEs at all.",
    ],
    code: { caption: "BEGIN, both UPDATEs and COMMIT on one checked-out client, ROLLBACK on any error:", text: "const client = await pool.connect();\ntry {\n  await client.query('BEGIN');\n  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, fromId]);\n  await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [100, toId]);\n  await client.query('COMMIT');\n} catch (err) {\n  await client.query('ROLLBACK');\n  throw err;\n} finally {\n  client.release();\n}" },
    breaks: [
      "Long transactions hold their connection and the rows they changed: other transfers touching those rows wait, and the pool runs short.",
      "All-or-nothing isn't retry-safe: if COMMIT succeeds but the response is lost, a retry transfers again. That needs idempotency.",
      "Two transfers that each read a balance and then write a new one can overwrite each other. Update in place (balance = balance - 100) or lock the row with SELECT … FOR UPDATE.",
      "ROLLBACK only undoes database writes: an email sent or a card charged inside the transaction stays done.",
    ],
  },
];
