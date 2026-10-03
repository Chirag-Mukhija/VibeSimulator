import { openai } from "@/lib/openai";
import { getPost } from "@/lib/posts";

export async function POST(req: Request) {
  const { id } = await req.json();
  const post = await getPost(id);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Summarize: ${post?.body}` }],
  });
  await fetch("https://hooks.slack.com/services/T000/B000/XXXX", {
    method: "POST",
    body: JSON.stringify({ text: "A post was summarized" }),
  });
  return Response.json({ summary: completion.choices[0]?.message.content });
}
