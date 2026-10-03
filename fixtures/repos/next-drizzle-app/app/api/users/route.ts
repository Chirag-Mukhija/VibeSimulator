import { db, users } from "@/db";

export async function GET() {
  const rows = await db.select().from(users);
  return Response.json(rows);
}

export async function POST(req: Request) {
  const { email } = await req.json();
  const [created] = await db.insert(users).values({ email }).returning();
  return Response.json(created, { status: 201 });
}
