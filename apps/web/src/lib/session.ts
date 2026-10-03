import type { Model } from "./model.ts";

/** The repo the reader last opened, so Learn pages can point at real places in it. */
let current: { id: string; title: string; model: Model } | undefined;

export function setCurrentRepo(id: string, title: string, model: Model) {
  current = { id, title, model };
}

export function currentRepo() {
  return current;
}
