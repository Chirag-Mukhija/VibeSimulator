import { eq } from "drizzle-orm";
import { db, users } from "@/db";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  await db.delete(users).where(eq(users.id, Number(params.id)));
  return new Response(null, { status: 204 });
}
