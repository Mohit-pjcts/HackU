// Starts the replica claims form (which is also the oracle) and the live panel.
import { startReplica } from "../replica/server.ts";
import { startPanel } from "./server.ts";

startReplica(8765);
const { server } = startPanel();
console.log(`replica claims form  http://127.0.0.1:8765/`);
console.log(`live panel           http://127.0.0.1:${server.port}/`);
console.log(process.env.TYPESAFE_API_KEY ? "classifier           TypeSafe jev" : "classifier           OFFLINE POLICY (no TYPESAFE_API_KEY in .env), labelled in the panel");
