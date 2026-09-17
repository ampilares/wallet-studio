// Disposable browser QA vault. This never opens the user's Studio vault.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StudioService } from "../dist/studio/service.js";
import { createStudioServer } from "../dist/studio/server.js";
const dir = await mkdtemp(path.join(tmpdir(), "wallet-studio-preview-"));
const service = new StudioService(dir);
await service.setup("studio QA fixture - no real funds");
const { server, launchUrl } = createStudioServer(service, path.resolve("dist/studio/public"), 4311);
server.listen(4311, "127.0.0.1", () => console.log(launchUrl));
const stop = () => { service.lock(); server.close(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
