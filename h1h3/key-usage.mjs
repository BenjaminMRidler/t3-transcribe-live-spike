// Prints the spike key's spend and limit (never the key itself).
import { keyUsage, requireApiKey } from './openrouter.mjs';

const usage = await keyUsage(requireApiKey());
console.log(JSON.stringify({ at: new Date().toISOString(), ...usage }));
