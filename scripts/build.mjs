import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Clamp Rust/Rayon/Tokio/Go thread pools so shared/cPanel hosting (CloudLinux NPROC limits)
// never panics with "Os { code: 11, kind: WouldBlock, message: Resource temporarily unavailable }".
const buildEnv = {
  ...process.env,
  RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '1',
  TOKIO_WORKER_THREADS: process.env.TOKIO_WORKER_THREADS || '1',
  UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '2',
  GOMAXPROCS: process.env.GOMAXPROCS || '1',
  OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
  ROLLDOWN_THREADS: process.env.ROLLDOWN_THREADS || '1'
};

function runNodeBin(binRelativePath, args) {
  const binPath = path.join(rootDir, 'node_modules', binRelativePath);
  const res = spawnSync(process.execPath, [binPath, ...args], {
    cwd: rootDir,
    env: buildEnv,
    stdio: 'inherit'
  });
  if (res.error) {
    console.error(`[build] Failed to run ${binRelativePath}:`, res.error.message);
    process.exit(1);
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    process.exit(res.status);
  }
  if (res.signal) {
    console.error(`[build] Process ${binRelativePath} killed by signal ${res.signal}`);
    process.exit(1);
  }
}

runNodeBin('vite/bin/vite.js', ['build', '--configLoader', 'runner']);
runNodeBin('esbuild/bin/esbuild', [
  'server.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--packages=external',
  '--sourcemap',
  '--outfile=dist/server.js'
]);
