// Started only under flock --no-fork by SharedBackend. No TCP listener.
import { rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { servicePaths, prepareServiceDirectory } from '../shared.ts';
import { startService } from '../server.ts';
const root = process.argv[2];
if (!root || !isAbsolute(root)) throw new Error('Expected an absolute private service directory');
prepareServiceDirectory(root);
rmSync(servicePaths(root).socket, { force: true });
const service = await startService({ root });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void service.close().then(() => process.exit(0), () => process.exit(1));
});
