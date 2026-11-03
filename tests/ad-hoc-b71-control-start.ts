import { createServer } from "node:net";
import { ControlClient, uniquePipeName } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  const name = uniquePipeName("b71-delayed-control");
  const path = IS_WIN ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
  const server = createServer();
  const timer = setTimeout(() => server.listen(path), 10_500);
  try {
    const client = await ControlClient.connect(name);
    client.close();
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
