// Spike C fixture B: nested child that stays alive.
console.log(`NESTED_CHILD_PID=${process.pid}`);
setInterval(() => undefined, 1000);
