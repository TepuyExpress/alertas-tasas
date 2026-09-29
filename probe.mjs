import {collect, transition} from './worker.js';
const readings = await collect();
console.log(JSON.stringify(readings, null, 2));
console.log(transition(null, readings, new Date().toISOString(), 'probe-no-telegram').message);
if (Object.values(readings).some(r => !r.ok)) process.exitCode = 1;
