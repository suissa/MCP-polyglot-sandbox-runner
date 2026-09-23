import { checkDockerAndGvisor } from './tools.ts';

export async function getRuntimesResourceContent() {
  const docker = await checkDockerAndGvisor();
  return JSON.stringify(
    {
      runtimes: {
        javascript: { image: 'node:22-alpine', defaultCommand: ['node', '-'] },
        python: { image: 'python:3.12-alpine', defaultCommand: ['python', '-'] },
        bash: { image: 'alpine:latest', defaultCommand: ['sh', '-s'] },
      },
      isolationEngine: docker.runscAvailable ? 'gVisor (runsc)' : 'standard-runc-isolated',
      docker,
      securityPolicies: {
        networkIsolation: 'NONE (--network=none)',
        rootFilesystem: 'READ_ONLY (--read-only)',
        privileges: 'NO_NEW_PRIVILEGES, CAP_DROP=ALL',
        tmpfs: '/tmp:rw,noexec,nosuid,size=64m',
        pidsLimit: 100,
      },
    },
    null,
    2
  );
}

export function getConfigResourceContent() {
  return JSON.stringify(
    {
      defaults: {
        memoryLimit: '256m',
        cpuLimit: '1.0',
        timeoutMs: 10000,
        maxBufferBytes: 5242880,
        maxArtifactBytes: 52428800,
      },
      supportedTransports: ['stdio', 'rest', 'websocket', 'nats'],
      ports: {
        rest: 7631,
        websocket: 7632,
      },
      nats: {
        subject: 'sandboxrunner.rpc',
        queue: 'sandboxrunner',
      },
    },
    null,
    2
  );
}
