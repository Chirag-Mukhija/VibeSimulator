import { prisma } from "./prisma";

export async function listPosts(limit = 20) {
  return prisma.post.findMany({ take: limit, orderBy: { createdAt: "desc" } });
}

export async function createPost(title: string, body: string, tagNames: string[]) {
  const post = await prisma.post.create({ data: { title, body } });
  for (const name of tagNames) {
    await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
  }
  return post;
}

export async function getPost(id: string) {
  return prisma.post.findUnique({ where: { id } });
}
