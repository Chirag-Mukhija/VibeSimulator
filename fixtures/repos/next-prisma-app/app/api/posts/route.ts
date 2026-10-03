import { NextResponse } from "next/server";
import { listPosts, createPost } from "@/lib/posts";

export async function GET() {
  const posts = await listPosts();
  return NextResponse.json(posts);
}

export async function POST(req: Request) {
  const { title, body, tags } = await req.json();
  const post = await createPost(title, body, tags ?? []);
  return NextResponse.json(post, { status: 201 });
}
