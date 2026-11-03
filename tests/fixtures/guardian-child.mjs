#!/usr/bin/env node
// A guardian child that exits promptly when its group receives SIGTERM.
process.on('SIGTERM', () => { process.exit(0) })
process.on('SIGINT', () => { process.exit(0) })
setInterval(() => {}, 1000)
