import { listPosts } from "@/lib/posts";
import { Feed } from "@/components/Feed";
import { NewPostForm } from "@/components/NewPostForm";

export default async function Home() {
  const posts = await listPosts(5);
  return (
    <main>
      <h1>{posts.length} recent posts</h1>
      <NewPostForm />
      <Feed />
    </main>
  );
}
