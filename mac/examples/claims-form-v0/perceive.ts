// Turns raw accessibility elements into at most CAP numbered "items" the classifier can choose between.
// Only controls inside the web page are kept: browser chrome (address bar, toolbar) can never be clicked.
import type { AxElement, Item, Observation } from "./contracts.ts";

export const CAP = 30;

const CONTROL_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXPopUpButton",
  "AXRadioButton",
  "AXCheckBox",
  "AXButton",
  "AXLink",
  "AXComboBox",
]);

export const ROLE_WORDS: Record<string, string> = {
  AXTextField: "text field",
  AXTextArea: "text area",
  AXPopUpButton: "drop-down",
  AXRadioButton: "radio button",
  AXCheckBox: "checkbox",
  AXButton: "button",
  AXLink: "link",
  AXComboBox: "combo box",
};

/** elements that live under an AXWebArea (the page), in tree order */
export function webElements(obs: Observation): AxElement[] {
  const byIndex = new Map<number, AxElement>();
  for (const e of obs.elements) byIndex.set(e.index, e);
  const inWeb = new Map<number, boolean>();
  const isInWeb = (e: AxElement): boolean => {
    const cached = inWeb.get(e.index);
    if (cached !== undefined) return cached;
    let r = false;
    if (e.role === "AXWebArea") r = true;
    else if (e.parent !== undefined) {
      const p = byIndex.get(e.parent);
      r = p ? isInWeb(p) : false;
    }
    inWeb.set(e.index, r);
    return r;
  };
  return obs.elements.filter((e) => e.role !== "AXWebArea" && isInWeb(e));
}

const isPlaceholder = (v: string | undefined) => !v || v.trim() === "" || /^choose/i.test(v.trim());

export function stateOf(e: AxElement): Item["state"] {
  switch (e.role) {
    case "AXTextField":
    case "AXTextArea":
    case "AXComboBox":
      return e.value && e.value.trim() !== "" ? "filled" : "empty";
    case "AXPopUpButton":
      return isPlaceholder(e.value) ? "empty" : "filled";
    case "AXRadioButton":
    case "AXCheckBox":
      return e.value === "1" ? "selected" : "unselected";
    default:
      return "n/a";
  }
}

export function perceive(obs: Observation, cap = CAP): Item[] {
  const controls = webElements(obs).filter((e) => CONTROL_ROLES.has(e.role) && e.token && e.label);
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const e of controls) {
    const id = `${e.role}:${e.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      i: out.length,
      id,
      text: e.label!,
      role: e.role,
      token: e.token,
      value: e.value,
      state: stateOf(e),
      where: "",
    });
    if (out.length >= cap) break;
  }
  const n = out.length;
  out.forEach((it, k) => (it.where = k < n / 3 ? "top" : k < (2 * n) / 3 ? "middle" : "bottom"));
  return out;
}

/** a cheap fingerprint of what the page shows, used to detect "nothing changed" */
export function signature(items: Item[]): string {
  return items.map((i) => `${i.id}=${i.value ?? ""}`).join("|");
}
