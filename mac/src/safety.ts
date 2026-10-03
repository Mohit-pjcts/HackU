// What an agent never does on its own, whatever the app: type a secret, or make a click that spends money or destroys
// something the goal did not ask for. These are checks on the control's label, the same in every app.

/** fields for secrets: the agent never types into them, the user does that part */
const SECRET_FIELD = /pass(word|code|phrase)|\bpin\b|card ?number|credit card|\bcvv\b|\bcvc\b|security code|expiry|social security|\bssn\b|passport|\bhkid\b|one[- ]time code|\botp\b/i;

/** clicks that cost money or can't be taken back */
const IRREVERSIBLE = /\b(buy|purchase|pay|payment|checkout|check out|place (the )?order|order now|book now|delete|erase|transfer|withdraw|uninstall|empty (the )?(trash|bin)|move to (the )?(trash|bin)|subscribe)\b/i;

export function typingForbidden(label: string): string | null {
  return SECRET_FIELD.test(label) ? `'${label.slice(0, 40)}' asks for a secret (password, card or ID). Agents never type those: please do this part yourself.` : null;
}

/** null when the click is fine; otherwise why not. Allowed when the goal itself asks for that action ("delete the draft") */
export function clickForbidden(label: string, goal: string): string | null {
  const m = label.match(IRREVERSIBLE);
  if (!m) return null;
  // the goal names the same action ("delete the draft", "place the order"): the user asked for it
  const first = (x: string) => x.toLowerCase().split(/\s+/)[0];
  const asked = [...goal.matchAll(new RegExp(IRREVERSIBLE.source, "gi"))].some((g) => first(g[0]) === first(m[0]));
  if (asked) return null;
  return `'${label.slice(0, 40)}' would ${m[0].toLowerCase()}, and the goal does not ask for that`;
}
