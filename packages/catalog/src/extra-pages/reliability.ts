import type { LearnPage } from "../pages.ts";

/** Learn pages for the reliability concepts: timeouts, circuit breakers, retries, idempotency and backpressure. */
export const reliabilityPages: LearnPage[] = [
  {
    concept: "timeouts",
    problem: "Your handler calls another service: a payment provider, a shipping API, one of your own services. If that service hangs, your handler hangs with it, and everything the request holds (its socket, its memory, maybe a pooled connection) stays held. Node's fetch waits minutes by default, so a stuck dependency can tie up everything that has to wait on it.",
    how: [
      "A timeout puts a limit on the wait. When it runs out, the call is cancelled, its connection is freed, and your code gets an error it can handle: answer 504 Gateway Timeout, or fall back to a cached or default answer.",
      "Without one, stuck calls keep whatever they hold. When calls to that service share something limited (a cap on connections to it, a database connection held during the call), a handful of calls that never return leave nothing for the requests behind them, even when most calls are fast.",
      "Pick the limit from how long healthy calls really take, a little above the slowest normal ones. Too generous, and stuck calls still hold things for a long time; too tight, and healthy calls that are only slow get cut off and fail.",
      "Set one on every outgoing call: HTTP requests, database queries (Postgres has statement_timeout), calls to caches and queues.",
    ],
    code: { caption: "Give up after 2 s and answer 504 (or a fallback):", text: "app.get('/rates', async (req, res, next) => {\n  try {\n    const r = await fetch(RATES_URL, { signal: AbortSignal.timeout(2000) });\n    res.json(await r.json());\n  } catch (err) {\n    if (err.name !== 'TimeoutError') return next(err);\n    res.status(504).json({ error: 'rates service timed out' });\n  }\n});" },
    breaks: [
      "Too tight: slow but healthy calls fail, and users see errors that a little more patience would have avoided.",
      "A timeout only cancels your side. The other service may still finish the work, so a timed-out call that charged a card or wrote a row can't simply be repeated unless it is idempotent.",
      "Limits that don't shrink inward: if the load balancer gives up after 30 s, a 60 s timeout on a call inside the request is never reached.",
      "Many calls timing out together means the dependency is down, and each still costs the full wait. A circuit breaker stops making those calls.",
    ],
  },
  {
    concept: "circuit-breaker",
    problem: "When a service you depend on goes down, every call to it still fails slowly: each one waits for its timeout first. Your users wait for errors, your app holds connections for calls that can't succeed, and the struggling service keeps getting traffic while it tries to recover.",
    how: [
      "A circuit breaker wraps the call and counts failures. While it is closed, calls pass through. After a set number of failures in a row it opens: for a cooldown period every call fails at once, and nothing is sent to the service.",
      "When the cooldown ends it goes half-open and lets one trial call through, while other calls keep failing fast. If the trial succeeds the breaker closes and traffic flows again; if it fails, the breaker opens for another cooldown.",
      "Failing fast is the point: an error right away instead of after a timeout, which you can turn into a 503 or a fallback (a cached value, a default, a feature hidden for now).",
      "Libraries such as opossum do this for you. Opossum opens on a percentage of failures over a rolling window rather than a count in a row, but the three states work the same way.",
    ],
    code: { caption: "With opossum, wrap the call once and fire it per request:", text: "const breaker = new CircuitBreaker(getStock, { timeout: 2500, resetTimeout: 5000 });\nbreaker.fallback(() => ({ stock: 'unknown' }));\n\n// in a handler\nconst stock = await breaker.fire(productId);" },
    breaks: [
      "The cooldown is a trade-off: too long keeps turning users away after the service has recovered; too short sends more trial calls into an outage, each one waiting out the timeout.",
      "Each instance of your app has its own breaker, so each one has to see failures for itself before it opens.",
      "Counting the wrong errors: a 404 or a validation error says nothing about the service's health and shouldn't open the breaker.",
      "It needs a timeout underneath: a call that hangs forever never counts as a failure.",
    ],
  },
  {
    concept: "retries-backoff",
    problem: "Many failures are temporary: a 503 during a deploy, a dropped connection, a timeout while a service is busy. Trying again a little later often works. Trying again at once, from every client, multiplies the load on a service that is already failing and wastes the tries.",
    how: [
      "Retry only errors that can succeed later: timeouts, dropped connections, 502, 503, 504, 429. A 400 or a 404 will fail the same way every time.",
      "Wait longer before each try: exponential backoff doubles the delay (1 s, 2 s, 4 s), so a request's tries are spread over a longer stretch instead of all landing in the first seconds of an outage. Add a random part (jitter) so clients that failed at the same moment don't all come back at the same moment.",
      "Cap the tries. After the last one, give up and report the error, or hand the work to a queue to try later. Without a cap, a long outage keeps every client retrying forever.",
      "Immediate retries do the opposite: each failed request comes straight back, so the failing service gets several times its usual load (a retry storm) and every try lands inside the same outage.",
    ],
    code: { caption: "Backoff with jitter and a cap, only for errors worth retrying:", text: "import { setTimeout as sleep } from 'node:timers/promises';\n\nasync function withRetry(fn, tries = 4) {\n  for (let attempt = 1; ; attempt++) {\n    try { return await fn(); }\n    catch (err) {\n      if (attempt >= tries || !isRetryable(err)) throw err;  // 503 or timeout: yes; 400: no\n      const base = 1000 * 2 ** (attempt - 1);                 // 1 s, 2 s, 4 s\n      await sleep(base / 2 + Math.random() * base);           // plus jitter\n    }\n  }\n}" },
    breaks: [
      "Retrying work that isn't safe to repeat: a retried payment can charge twice unless the call is idempotent.",
      "Retries at several layers multiply: 3 tries in the browser, 3 in your API and 3 in its client library can turn one click into as many as 27 calls.",
      "A long outage outlasts any retry budget. A circuit breaker stops the calls sooner; a queue keeps the work for later.",
      "Ignoring Retry-After on a 429 or 503: the server already said when to come back.",
    ],
  },
  {
    concept: "idempotency",
    problem: "A client sends a payment, the charge goes through, and the response is lost on the way back: a dropped connection, a timeout. The client can't tell whether it worked, so it sends the payment again, and without protection the customer is charged twice.",
    how: [
      "An operation is idempotent when doing it twice has the same effect as doing it once. Reads already are; payments and inserts are not, unless you make them so.",
      "The client creates a unique Idempotency-Key for each operation and sends it with every attempt. The server stores the key together with the result. A request with a key it has already seen gets the stored result back instead of doing the work again.",
      "Store the key first, in a column with a UNIQUE constraint. Two copies arriving at the same moment (a double click, a retry racing the original) can't both insert it: the second finds the key taken and gets the stored result, or 409 Conflict while the first is still running. Looking the key up in code and saving it afterwards leaves a gap where both copies pass the check.",
      "Payment providers use the same idea: Stripe accepts an idempotency key, so passing yours along means a retry can't charge twice there either.",
    ],
    code: { caption: "Insert the key first; a repeat finds it taken:", text: "const key = req.get('Idempotency-Key');\nconst ins = await db.query(\n  'INSERT INTO idempotency_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);\nif (ins.rowCount === 0) {                 // seen before\n  const { rows } = await db.query('SELECT result FROM idempotency_keys WHERE key = $1', [key]);\n  return rows[0].result ? res.json(rows[0].result) : res.status(409).end();\n}\nconst charge = await stripe.paymentIntents.create(params, { idempotencyKey: key });\nawait db.query('UPDATE idempotency_keys SET result = $2 WHERE key = $1', [key, charge]);\nres.json(charge);" },
    breaks: [
      "Keys made in the wrong place: a key generated on the server per request, or a new one for each retry, protects nothing. It must come from the client, once per operation.",
      "Keys kept too briefly: they must outlive every retry (Stripe keeps them for at least 24 hours), then expire.",
      "A crash between the charge and saving the result leaves the key marked in progress with nothing to return. Passing the key to the provider keeps the next retry from charging again.",
      "The same key with a different body (another amount) is a client bug; reject it rather than returning the old result.",
    ],
  },
  {
    concept: "backpressure",
    problem: "A producer adds work faster than consumers finish it: uploads arrive faster than workers process them, events stream in faster than you can store them. An unbounded queue hides this for a while, then its memory and the wait for each new item grow until something runs out of memory or users wait minutes for results.",
    how: [
      "Backpressure means the slow side pushes back on the fast side. Give the queue a limit, and decide what happens when it is full.",
      "The producer waits: it adds nothing more until there is room, so the slowdown travels back toward the source. Node streams work this way: write() returns false when the buffer is full, and pipe() pauses the source until 'drain'.",
      "Or the server sheds load: it refuses new work with 503 Service Unavailable (or 429 Too Many Requests when one client is over its share), often with a Retry-After header, and the client tries again later.",
      "Either way the consumers finish work no faster than before. A limit decides where the waiting happens and caps the memory and delay it costs; to get more done you need more or faster consumers.",
    ],
    code: { caption: "Refuse new work when the queue is already long:", text: "app.post('/uploads', async (req, res) => {\n  if (await queue.getWaitingCount() >= 1000) {\n    res.set('Retry-After', '2');\n    return res.status(503).json({ error: 'busy, try again shortly' });\n  }\n  await queue.add('process', { fileId: req.body.fileId });\n  res.status(202).json({ queued: true });\n});" },
    breaks: [
      "Holding requests while waiting for room still costs a socket and some memory per request. With many clients, that waiting needs its own limit, after which you refuse.",
      "A limit set too low refuses work during short bursts that the consumers would have caught up with.",
      "Clients that retry a 503 at once add load instead of waiting: they should honor Retry-After or back off.",
      "Every hop needs a limit: a bounded queue fed from an unbounded buffer in memory still grows without limit.",
    ],
  },
];
