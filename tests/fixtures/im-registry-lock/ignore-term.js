process.on('SIGTERM', () => {});
process.send?.('ignoring-term');
// IPC plus this interval keep the test child alive until SIGKILL.
setInterval(() => {}, 1000);
