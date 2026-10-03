import { getPost } from "@/lib/posts";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const post = await getPost(params.id);
  if (!post) return new Response("Not found", { status: 404 });
  return Response.json(post);
}
