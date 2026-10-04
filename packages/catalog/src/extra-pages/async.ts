import type { LearnPage } from "../pages.ts";

/** Learn pages for the background-work concepts: dead-letter queues, scheduled jobs and webhooks. */
export const asyncPages: LearnPage[] = [
  {
    concept: "dead-letter-queue",
    problem: "Some jobs can never succeed: a bug crashes the worker on certain data, or the order a job refers to has been deleted. Retried forever, they keep taking workers away from jobs that would succeed. Deleted after a few tries, they vanish, and nobody learns which orders were never handled.",
    how: [
      "Give every job a limit on tries, with a wait between them. When a job fails its last try, it moves to a separate dead-letter queue (DLQ) together with its data and the error it threw, and the main line keeps moving. In Amazon SQS the DLQ is a second queue named in the redrive policy; in BullMQ, jobs that used up their attempts stay in the failed set.",
      "Nothing in the DLQ runs on its own. A person looks at it: when every job there fails with the same error, that points straight at the bug. Once the fix is deployed, they replay the jobs, which puts them back on the main queue with their original data.",
      "Alert on the DLQ's size. One that fills up without anyone noticing is just a slower way of losing jobs.",
    ],
    code: { caption: "BullMQ: a limit on tries, and replaying failed jobs once the fix is out:", text: "await queue.add('receipt', { orderId }, {\n  attempts: 3,                                   // then the job stays in the failed set\n  backoff: { type: 'exponential', delay: 1000 },\n});\n\n// after deploying the fix\nfor (const job of await queue.getFailed()) await job.retry();" },
    breaks: [
      "Replaying before the fix is deployed: every job fails all its tries again and lands right back in the DLQ.",
      "Jobs that did part of their work before failing: replaying one that already charged a card charges again, unless the job is idempotent.",
      "Errors that can never succeed, such as invalid data, still use up every try. BullMQ's UnrecoverableError fails a job at once instead.",
      "A DLQ nobody reads: messages expire there too (SQS keeps them at most 14 days), so the jobs are lost after all, just later.",
    ],
  },
  {
    concept: "cron",
    problem: "Some work isn't triggered by a request: send reminders every hour, delete expired sessions every night, bill subscriptions on the 1st. A scheduler in your code runs it on a timer. The trouble starts when you run several copies of your app, because every copy has the same schedule.",
    how: [
      "A cron expression says when: `0 * * * *` means minute 0 of every hour. A library such as node-cron calls your function at those times, inside your app's own process, using that machine's clock.",
      "Three instances means three schedulers firing at about the same moment, so the job runs three times: three copies of every email, or three charges. Let only one of them run it by taking a lock first: a Redis key set with NX, which only the first caller can create, with an expiry so a crashed holder can't keep it forever. The other way is to keep the schedule in one place that adds a job to a queue for the workers.",
      "A job that takes longer than its interval overlaps the next run unless something stops it. Holding the lock until the run finishes makes the next run find it taken and skip. Write the job to pick up whatever is still due, so the following run catches up on a skipped one.",
    ],
    code: { caption: "Every instance runs this; only the one whose SET succeeds does the work:", text: "cron.schedule('0 * * * *', async () => {\n  const got = await redis.set('lock:reminders', instanceId, 'PX', 2 * 60 * 60_000, 'NX');\n  if (!got) return;                  // another instance has it\n  try { await sendDueReminders(); }\n  finally { await redis.del('lock:reminders'); }\n});" },
    breaks: [
      "A lock that expires while the job is still running lets another instance start a second copy. Set the expiry longer than the slowest run.",
      "Machines' clocks differ by a little. If a short job deletes its lock before a lagging instance's timer fires, that instance runs the same hour again; a lock named after the run (lock:reminders:2026-10-04T09) that is left to expire avoids it.",
      "A run that falls due while every instance is restarting is simply missed: an in-process scheduler doesn't catch up afterwards.",
      "Heavy jobs inside the web process share its CPU and memory with requests. Move them to a worker.",
    ],
  },
  {
    concept: "webhooks",
    problem: "You need to know when something happens in another service: a payment succeeds, a pull request is merged. Polling its API every few seconds wastes requests and is still late. With a webhook, the service sends an HTTP POST to a URL you gave it as soon as the event happens.",
    how: [
      "Your webhook URL is public, so anyone can POST to it. The provider signs each request with a secret only the two of you know (an HMAC of the body, sent in a header). Check the signature against the raw body before trusting anything, and reject a mismatch with 400.",
      "Answer with a 2xx quickly. The provider waits only so long; with no answer in time it counts the delivery as failed, and providers such as Stripe send the event again later, waiting longer between tries. So queue the work, answer 200, and let a worker do the slow part.",
      "Delivery is at least once: when your answer is late or lost on the way, the same event arrives again. Record each event id under a UNIQUE constraint and skip ids you have already handled. Retries also mean events can arrive out of order.",
    ],
    code: { caption: "With Stripe's library; the signature check needs the raw body:", text: "app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {\n  let event;\n  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), secret); }\n  catch { return res.sendStatus(400); }        // forged or altered\n  await queue.add('fulfil', { eventId: event.id });\n  res.sendStatus(200);                         // answer now, work later\n});\n// worker: INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING; skip if no row" },
    breaks: [
      "Parsing the body with express.json() before verifying: the signature covers the exact raw bytes, so the check fails, and the tempting fix is to skip it.",
      "Doing the slow work before answering: every timeout brings another delivery, and without the id check the work runs again.",
      "Your endpoint is down for a while: events pile up at the provider and arrive in a burst when it is back, or are dropped once the provider stops retrying.",
    ],
  },
];
