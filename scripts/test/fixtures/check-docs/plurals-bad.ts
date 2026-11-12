// Every line marked "plural" shows the owner a count written with "(s)".
export const unreadable = (n: number) => `${n} event(s) could not be read`; // plural
export const skipped = (n: number, days: number) => `${n} thread(s) outside the ${days}-day window`; // plural
export const refused = (ids: string[]) => new Error(`Unknown Scope(s): ${ids.join(", ")}`); // plural
export const matched = { message: "Some match(es) were hidden" }; // plural
export const counted = (n: number) => `${n} file(s)`; // plural
