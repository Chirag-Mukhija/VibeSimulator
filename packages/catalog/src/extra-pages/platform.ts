import type { LearnPage } from "../pages.ts";

/** Learn pages for sessions and JWTs, presigned uploads, Server Actions and Node's thread pool. */
export const platformPages: LearnPage[] = [
  {
    concept: "sessions-jwt",
    problem: "HTTP remembers nothing between requests, so every request has to show who sent it. Nobody types a password per click, so after one login the server hands the browser something to send back each time: a session id or a signed token. The choice decides what each request costs and whether logging out really works.",
    how: [
      "Session: at login the server writes a record (user id, expiry) to a store such as Redis or Postgres and sends back only a random id in a cookie. Each request carries the cookie, and the server looks the id up to learn who it is: one store round trip per request. Logging out deletes the record, so the id is worthless from that moment, even if someone copied it.",
      "JWT (JSON Web Token): the server puts the claims (user id, expiry) in the token itself and signs them with a secret key. On each request it checks the signature and the expiry with CPU alone, no lookup, so any instance can check a token without shared state.",
      "The catch: nothing on the server keeps track of the tokens it signed, so nothing can cancel one before it expires. Logging out only makes the browser forget it; a stolen copy keeps working. The usual answers are short-lived access tokens renewed with a refresh token that is kept server-side and can be revoked, or a denylist of revoked token ids, which brings the per-request lookup back.",
    ],
    code: { caption: "Both in Express:", text: "// Session: the cookie holds an id; the store is read on every request\napp.use(session({ store: new RedisStore({ client: redis }), secret: process.env.SESSION_SECRET }));\napp.post('/logout', (req, res) => req.session.destroy(() => res.sendStatus(204)));\n\n// JWT: checked with the key alone\nconst user = jwt.verify(token, process.env.JWT_SECRET); // throws if forged or expired" },
    breaks: [
      "A JWT can't be revoked early: a stolen token, a banned user or a removed role stays valid until it expires. Keep access tokens short-lived.",
      "A token kept in localStorage can be read by any script that runs on your page (an XSS bug); an HttpOnly cookie can't be read by JavaScript at all.",
      "Sessions put the store on every request's path: if Redis is slow or down, so is every signed-in request.",
      "A JWT's claims are signed, not encrypted: anyone holding it can read them, and every claim you add travels on every request.",
    ],
  },
  {
    concept: "presigned-uploads",
    problem: "Users upload photos and videos. The obvious route is a POST to your API, which passes the file on to storage such as S3. Then every byte crosses your server: it pays for the bandwidth twice, holds the request open for as long as the user's upload takes, and with multer's default settings keeps the whole file in memory.",
    how: [
      "With a presigned URL, the browser first asks your API for permission. The API checks who is asking, then signs a URL that allows one method (PUT) on one object key and expires in a few minutes. Signing is a calculation with your secret key, not a network call to S3.",
      "The browser uploads straight to storage with that URL. Storage checks the signature and the expiry itself and stores the object. Your API takes no part while the bytes move, so a 2 GB video costs it two small requests.",
      "Afterwards the browser tells your API the upload is done, and the API records the key, ideally after checking that the object exists. The same idea works for downloads: a presigned GET URL lets a browser fetch a private file for a few minutes.",
    ],
    code: { caption: "The API signs; the browser uploads:", text: "app.post('/uploads', requireUser, async (req, res) => {\n  const key = `uploads/${req.user.id}/${crypto.randomUUID()}`;\n  const command = new PutObjectCommand({ Bucket, Key: key, ContentType: req.body.type });\n  const url = await getSignedUrl(s3, command, { expiresIn: 300 }); // computed locally\n  res.json({ url, key }); // the browser PUTs the file to url\n});" },
    breaks: [
      "The URL is a permission anyone holding it can use until it expires: keep the expiry short and sign one key per upload.",
      "A presigned PUT doesn't cap the file size by itself. A presigned POST policy can (content-length-range), or check the object's size afterwards.",
      "The browser can claim an upload it never made: confirm with a HEAD request or a storage event before trusting it.",
      "The bucket needs CORS rules that allow your site, or the browser blocks the direct upload.",
    ],
  },
  {
    concept: "server-actions",
    problem: "In Next.js you can mark a function with 'use server', import it into a client component and call it like any other function. It feels local, which makes two things easy to forget: every call is a network round trip, and the function is a public endpoint.",
    how: [
      "When a client component calls the action, Next.js sends an HTTP POST to the current page's URL. A Next-Action header carries the action's id, and the body carries the arguments, serialized. The server finds the function by its id, runs it, and sends the return value back in the response. Only then does the await in the browser finish.",
      "So it costs what any request costs: a round trip plus the work. Calling an action once per item in a loop sends one POST after another; pass the whole list in one call instead.",
      "The action's id is in your page's JavaScript, so anyone can send that POST with any arguments, from a script, without loading the page. Hiding a button, or checking login while rendering the page, does not protect the action. Each action must check the session and validate its input itself, exactly like an API route.",
    ],
    code: { caption: "The check lives inside the action:", text: "'use server';\nexport async function deleteTodo(id: number) {\n  const user = await currentUser();          // reads the session cookie\n  if (!user) throw new Error('Not signed in');\n  await db.todo.deleteMany({ where: { id, ownerId: user.id } }); // only your own\n}" },
    breaks: [
      "No check inside the action: anyone who finds its id can call it with any arguments.",
      "Arguments come from the network, and TypeScript types aren't checked at runtime: validate them (with zod, for example) like any request body.",
      "Actions called in a loop: one POST per call, each waiting for the last. Batch the work into one call.",
      "Actions used for reading data: Next.js currently sends them one at a time, so reads queue behind each other. Fetch in a Server Component or a route handler instead.",
    ],
  },
  {
    concept: "thread-pool",
    problem: "Node runs your JavaScript on one thread, yet fs.readFile, dns.lookup and bcrypt's async hash don't block it. They run on a small pool of background threads kept by libuv, the library that does Node's I/O: 4 threads by default, however many cores the machine has. When those 4 are busy, everything that needs one waits in the same line.",
    how: [
      "The pool takes work the operating system can't do asynchronously: file system calls, dns.lookup (used whenever you connect to a hostname), and CPU-heavy calls such as crypto.pbkdf2, crypto.scrypt, the bcrypt package's async functions and zlib compression. The event loop hands the task over and moves on; your callback or promise runs when a thread finishes.",
      "Network sockets don't use it. Database queries over an open connection and HTTP requests and responses are watched by the event loop through the operating system, so they keep flowing while the pool is full.",
      "Four threads fill up fast: four password hashes at once take every thread, and a fifth hash, a file read or a DNS lookup waits behind them, though it has nothing to do with logins. Setting UV_THREADPOOL_SIZE when the process starts makes the pool bigger, which helps when the machine has spare cores to run the extra threads.",
    ],
    code: { caption: "Which calls need a pool thread:", text: "// package.json: \"start\": \"UV_THREADPOOL_SIZE=8 node server.js\"\nconst hash = await bcrypt.hash(password, 12);   // a pool thread\nconst html = await fs.promises.readFile(path);  // a pool thread too: the same line\nconst { rows } = await db.query(sql);           // a socket: no pool thread" },
    breaks: [
      "Many async hashes or compressions at once: file reads and DNS lookups slow down for reasons that look unrelated.",
      "A bigger pool adds threads, not CPU: with more busy threads than cores they share the cores, so CPU-heavy work finishes no sooner in total.",
      "bcryptjs (pure JavaScript) and sync calls like bcrypt.hashSync don't use the pool: their work runs on the main thread, where it competes with every request.",
      "Many new outgoing connections: each needs a dns.lookup on a pool thread, since Node doesn't cache DNS answers itself.",
    ],
  },
];
