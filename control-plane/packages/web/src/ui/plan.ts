/**
 * The plan panel.
 *
 * An agent republishes its whole plan on every change, so this patches in place
 * rather than rebuilding: the common update is three identical lines with one
 * status moved on, and a rebuild would make the panel flash on every step.
 *
 * Hidden entirely when there is no plan. An empty panel labelled "no plan" is
 * chrome, and chrome is what makes a dense surface unreadable.
 */

import type { PlanEntry, PlanStatus } from "../session/model.ts";
import { el, setText, toggleClass } from "./dom.ts";
import { icon } from "./icons.ts";

export interface PlanView {
  readonly element: HTMLElement;
  render(plan: readonly PlanEntry[]): void;
}

interface Row {
  root: HTMLElement;
  label: HTMLElement;
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
};

export function createPlan(): PlanView {
  const progress = el("span", { class: "plan-progress", text: "0/0" });
  const chevron = el("span", { class: "plan-chevron", children: [icon("chevron")] });
  const head = el("button", {
    class: "plan-head",
    attrs: { type: "button", "aria-expanded": "true", "aria-controls": "plan-body" },
    children: [
      icon("plan"),
      el("span", { class: "plan-title", text: "Plan" }),
      progress,
      chevron,
    ],
  });

  const body = el("ol", { class: "plan-list", attrs: { id: "plan-body" } });

  const element = el("section", { class: "plan", children: [head, body] });
  element.hidden = true;

  const rows: Row[] = [];
  let open = true;

  head.addEventListener("click", () => {
    open = !open;
    body.hidden = !open;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    toggleClass(element, "is-open", open);
  });
  toggleClass(element, "is-open", open);

  return {
    element,
    render(plan: readonly PlanEntry[]): void {
      element.hidden = plan.length === 0;
      if (plan.length === 0) {
        body.replaceChildren();
        rows.length = 0;
        return;
      }

      while (rows.length > plan.length) {
        rows.pop()?.root.remove();
      }
      while (rows.length < plan.length) {
        const label = el("span", { class: "plan-text" });
        const root = el("li", {
          class: "plan-item",
          children: [el("span", { class: "plan-mark", attrs: { "aria-hidden": "true" } }), label],
        });
        rows.push({ root, label });
        body.append(root);
      }

      let done = 0;
      for (const [index, entry] of plan.entries()) {
        const row = rows[index];
        if (row === undefined) continue;
        if (entry.status === "completed") done += 1;
        setText(row.label, entry.content);
        row.root.setAttribute("data-status", entry.status);
        row.root.setAttribute("data-priority", entry.priority);
        // The mark is decorative, so the status has to reach a screen reader
        // through the row's own accessible name.
        row.root.setAttribute("aria-label", `${entry.content}: ${STATUS_LABELS[entry.status]}`);
      }

      setText(progress, `${done}/${plan.length}`);
      toggleClass(element, "is-complete", done === plan.length);
    },
  };
}
