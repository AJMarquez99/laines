import { createServer } from 'node:net';

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export async function busyPorts([start, end]) {
  const busy = [];
  for (let port = start; port <= end; port += 1) {
    if (!(await isFree(port))) busy.push(port);
  }
  return busy;
}
