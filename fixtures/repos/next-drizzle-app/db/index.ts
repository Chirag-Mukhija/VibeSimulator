import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", { id: serial("id").primaryKey(), email: text("email") });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

export const db = drizzle(pool);
