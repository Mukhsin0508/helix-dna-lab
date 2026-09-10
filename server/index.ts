import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";

const dbPath = fileURLToPath(
  new URL("../.data/sessions.sqlite", import.meta.url),
);
const app = await createApp(dbPath);
await app.listen({ host: "127.0.0.1", port: 4191 });
console.info(
  "DNA Lab API: http://127.0.0.1:4191 (local SQLite sessions; curated replay)",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      process.exit(0);
    });
  });
}
