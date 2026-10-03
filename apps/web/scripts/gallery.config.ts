import type { GalleryEntry } from "../src/lib/data.ts";

export interface GallerySource extends Omit<GalleryEntry, "stats"> {
  /** Repo-relative path of the source to analyze. */
  path: string;
}

export const GALLERY: GallerySource[] = [
  {
    id: "job-scheduler",
    path: "fixtures/repos/job-scheduler",
    title: "Job Scheduler",
    tagline: "A job queue built from scratch: Redis sorted sets, retries with backoff, a dead-letter path, and a live dashboard fed by Redis pub/sub over WebSockets.",
    repoUrl: "https://github.com/Chirag-Mukhija/Job-Scheduler",
    author: "Chirag Mukhija",
    stack: ["Express", "Postgres", "Redis", "WebSocket", "Worker"],
  },
  {
    id: "instabackend",
    path: "fixtures/repos/instabackend",
    title: "InstaBackend",
    tagline: "An Instagram-style API: JWT auth with Redis sessions, S3 presigned uploads, fan-out feeds and keyset pagination behind Nginx.",
    repoUrl: "https://github.com/Chirag-Mukhija/InstaBackend",
    author: "Chirag Mukhija",
    stack: ["Express", "Postgres", "Redis", "S3", "Nginx"],
  },
  {
    id: "paytmentgateway",
    path: "fixtures/repos/paytmentgateway",
    title: "Payment Gateway",
    tagline: "Idempotent payments on Postgres: API-key auth on every request, and each payment plus its first audit event in one transaction.",
    repoUrl: "https://github.com/Chirag-Mukhija/PaytmentGateway",
    author: "Chirag Mukhija",
    stack: ["Express 5", "Postgres"],
  },
];
