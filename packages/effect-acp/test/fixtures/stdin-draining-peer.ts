process.on("SIGTERM", () => {
  // Model agents that drain their protocol transport before exiting.
});

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
