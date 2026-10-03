// One hotkey for everything: is what the user said a job for the agents ("compute 128 times 37 in Calculator",
// "open YouTube and play the first video") or a question about the screen ("how do I…", "what does this button do")?
// Clear cases are decided in code; only an unclear one goes to jev. When jev isn't sure either, it is treated as a
// question: explaining never changes anything on the screen, acting does.
import { JevBrain } from "./decide.ts";

export type Route = { to: "agents" | "explain" | "stop"; via: "code" | "jev"; ms: number; confidence?: number };

const STOP = /^(stop|cancel|abort|halt)( (it|that|everything|the agents|agents|now))?$/;
const DISMISS = /^(stop|cancel|clear|never ?mind|hide|that's all|thanks|thank you)$/;
// a question about what's on the screen, asking to be taught, or asking for a drawing on the screen
const EXPLAIN = /^(underline|ring|circle|highlight|point (at|to|out)|draw|mark|annotate|label|how (do|can|would|should) i|how to|teach me|show me (how|where|what)|explain|what('s| is| are| does| do) (this|that|these|those|it|here|the .{1,30} (on|in) (my|the) screen)|what am i (looking|seeing)|where (is|are|do|can)|why (is|does|did|can't|won't)|which (button|one|key|menu|tab)|can you see|what does .* (do|mean)|is this|are these|next|repeat|again|back|previous|ok|okay|done|got it|continue|go on)\b/;
// an order: starts with an action verb ("please"/"can you" allowed in front)
const DO = /^((please|can you|could you|would you|go and|hey backstage,?) )*(open|launch|start|compute|calculate|work out|clear|add|subtract|multiply|divide|write|type|draft|make|create|save|search|look up|google|find|play|watch|organi[sz]e|sort|tidy|move|rename|put|set|turn|send|go to|visit|show|take|book|plan)\b/;
const IN_APP = /\b(in|on|using|with|via) (a new |the |my )?(calculator|safari|textedit|finder|notes|reminders|brave|chrome|word|youtube|google)\b/;

let jev: JevBrain | undefined;

export async function route(text: string, ctx: { lesson: boolean; agentsBusy: boolean }): Promise<Route> {
  const t0 = performance.now();
  const done = (to: Route["to"], via: Route["via"] = "code", confidence?: number): Route => ({ to, via, ms: Math.round(performance.now() - t0), confidence });
  const w = text.toLowerCase().replace(/[.!?,]+$/g, "").replace(/\s+/g, " ").trim();
  if (STOP.test(w) && ctx.agentsBusy) return done("stop");
  if (DISMISS.test(w)) return done("explain"); // "clear", "never mind": clears the drawings (not a job called "clear")
  if (EXPLAIN.test(w)) return done("explain");
  if (DO.test(w) || IN_APP.test(w)) return done("agents");
  if (ctx.lesson && w.split(" ").length <= 3) return done("explain"); // short replies during a lesson
  if (!process.env.TYPESAFE_API_KEY) return done("explain");
  jev ??= new JevBrain();
  try {
    const c = await jev.choose(
      `The user pressed the assistant hotkey and said: "${text}". Should agents DO this on the computer, or should the assistant EXPLAIN something on the screen?`,
      {
        agents: "a task to carry out in an app: open, compute, write, search, play, organise files",
        explain: "a question about what is on the screen, or how to do something (the user does it)",
      },
      { said: text },
    );
    return done(c.confidence >= 0.6 && c.choice === "agents" ? "agents" : "explain", "jev", c.confidence);
  } catch {
    return done("explain");
  }
}
