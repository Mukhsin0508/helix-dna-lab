import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
export function bindings(): { DB?: D1Database; HF_ENV?: string; APP_SLUG?: string } {return env as unknown as { DB?: D1Database; HF_ENV?: string; APP_SLUG?: string }}
