import { useEffect, useState } from "react";

/** Hash routes keep the static build working from any folder: #/repo/<id>?flow=... */
export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?");
  return { path: pathPart.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function href(path: string[], query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") q.set(k, v);
  const qs = q.toString();
  return `#/${path.map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}`;
}

export function navigate(path: string[], query?: Record<string, string | undefined>, replace = false) {
  const target = href(path, query);
  if (replace) window.history.replaceState(null, "", target);
  else window.location.hash = target.slice(1);
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}
