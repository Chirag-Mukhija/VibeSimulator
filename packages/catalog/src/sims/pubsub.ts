import { CALIBRATION } from "@vibesim/sim";
import { bucket, num, type Params, type SimDef, type SimResult } from "./types.ts";

/** Why pub/sub exists: pushing to sockets spread over several instances. */
function run(p: Params): SimResult {
  const instances = num(p, "instances");
  const users = num(p, "users");
  const rate = num(p, "rate");
  const perInstanceUsers = users / instances;
  const reachedLocal = 100 / instances;
  const sendsPerInstance = perInstanceUsers * rate;
  const cpuPerInstance = (CALIBRATION.cpuBusyBaseFraction + (sendsPerInstance * CALIBRATION.cpuPerWsMessageUs) / 1e6) * 100;
  const redisDeliveries = rate * instances;
  const singleCpu = (CALIBRATION.cpuBusyBaseFraction + (users * rate * CALIBRATION.cpuPerWsMessageUs) / 1e6) * 100;
  return {
    metrics: [
      { label: "Users who get a message without a backplane", value: reachedLocal, format: "pct", tone: reachedLocal < 100 ? "bad" : "good", hint: "only sockets on the instance that published" },
      { label: "Users who get it with Redis pub/sub", value: 100, format: "pct", tone: "good" },
      { label: "Redis deliveries per second", value: redisDeliveries, format: "rps", hint: "one copy of each message per subscribed instance" },
      { label: "Socket sends per second, per instance", value: sendsPerInstance, format: "rps" },
      { label: "CPU per instance for sending", value: cpuPerInstance, format: "pct", tone: cpuPerInstance > 90 ? "bad" : "good" },
    ],
    charts: [
      { type: "bars", title: "Share of users reached", unit: "%", bars: [
        { label: "No backplane", value: reachedLocal },
        { label: "Redis pub/sub", value: 100, highlight: true },
      ] },
      { type: "bars", title: "CPU to push every message to every user (% of one core)", unit: "%", bars: [
        { label: "1 instance", value: singleCpu, note: singleCpu > 95 ? "overloaded" : undefined },
        { label: `${instances} instances`, value: cpuPerInstance, highlight: true, note: cpuPerInstance > 95 ? "overloaded" : undefined },
      ] },
    ],
    verdict: instances === 1
      ? `With one instance every socket is local, so a plain loop over clients works. Add a second instance and half your users stop receiving pushes; that is the moment pub/sub becomes necessary.`
      : `Each instance only knows its own ${Math.round(perInstanceUsers).toLocaleString("en-US")} sockets, so a local broadcast reaches ${reachedLocal.toFixed(0)}% of users. Publishing to Redis gives every instance a copy (${redisDeliveries.toLocaleString("en-US")} deliveries/s), and each one pushes to its own sockets.`,
  };
}

export const pubsubSim: SimDef = {
  id: "pub-sub",
  title: "Reaching every user when they are spread across instances",
  knobs: [
    { type: "slider", id: "instances", label: "Server instances", min: 1, max: 12, step: 1 },
    { type: "slider", id: "users", label: "Connected users", min: 100, max: 200_000, log: true },
    { type: "slider", id: "rate", label: "Messages per second", min: 0.1, max: 50, log: true },
  ],
  defaults: { instances: 4, users: 20_000, rate: 2 },
  run,
  predict(p, r) {
    return {
      question: `${num(p, "instances")} instances sit behind a load balancer. One of them broadcasts a message to "all" its WebSocket clients. What share of users receive it?`,
      options: [{ id: "a", label: "100%" }, { id: "b", label: "About half" }, { id: "c", label: `About 1 in ${num(p, "instances")}` }],
      answer: num(p, "instances") === 1 ? "a" : num(p, "instances") === 2 ? "b" : bucket(r.metrics[0]!.value, [{ id: "a", at: 100 }, { id: "b", at: 50 }, { id: "c", at: 100 / num(p, "instances") }]),
    };
  },
  assumptions: [
    "Users spread evenly across instances (sticky sessions keep each socket on one instance).",
    `Socket send cost of ${CALIBRATION.cpuPerWsMessageUs} µs per message is measured (calibration/REPORT.md); Redis itself is not the bottleneck at these rates.`,
  ],
};
