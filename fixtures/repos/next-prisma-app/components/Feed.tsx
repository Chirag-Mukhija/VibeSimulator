"use client";

import { useEffect, useState } from "react";

export function Feed() {
  const [posts, setPosts] = useState<{ id: string; title: string }[]>([]);

  useEffect(() => {
    const load = () => fetch("/api/posts").then((r) => r.json()).then(setPosts);
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <ul>
      {posts.map((p) => (
        <li key={p.id}>
          {p.title}
          <button onClick={() => summarize(p.id)}>Summarize</button>
        </li>
      ))}
    </ul>
  );
}

async function summarize(id: string) {
  await fetch("/api/summarize", { method: "POST", body: JSON.stringify({ id }) });
}
