const KEY = "@mp_free_usage";
const FREE_SONGS_PER_MONTH = 3;

type FreeUsage = {
  month: string;
  count: number;
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function readUsage(): FreeUsage {
  if (typeof window === "undefined") {
    return { month: currentMonth(), count: 0 };
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as
      | FreeUsage
      | null;
    if (parsed?.month === currentMonth() && Number.isFinite(parsed.count)) {
      return parsed;
    }
  } catch {}

  return { month: currentMonth(), count: 0 };
}

export function shouldShowGate(): boolean {
  if (typeof window === "undefined") return false;
  return readUsage().count >= FREE_SONGS_PER_MONTH;
}

export function consumeFreeAction(): void {
  if (typeof window === "undefined") return;

  const usage = readUsage();
  localStorage.setItem(
    KEY,
    JSON.stringify({
      month: currentMonth(),
      count: Math.min(usage.count + 1, FREE_SONGS_PER_MONTH),
    })
  );
}

export function clearGate(): void {
  if (typeof window !== "undefined") localStorage.removeItem(KEY);
}
