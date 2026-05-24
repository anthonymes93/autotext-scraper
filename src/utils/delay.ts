const JITTER_FACTOR = 0.25; // ±25%

function withJitter(baseMs: number): number {
  const swing = baseMs * JITTER_FACTOR;
  return Math.floor(baseMs - swing + Math.random() * swing * 2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function delay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(ms);
}

export function computePageDelayMs(windowMinutes: number, maxPages: number): number {
  const windowMs = windowMinutes * 60 * 1000;
  return Math.floor(windowMs / maxPages);
}

export async function pageDelay(windowMinutes: number, maxPages: number): Promise<void> {
  const baseMs = computePageDelayMs(windowMinutes, maxPages);
  const actual = withJitter(baseMs);
  return new Promise((resolve) => setTimeout(resolve, actual));
}

// Smaller delay between listing detail page visits — not part of the window budget.
export async function listingDelay(): Promise<void> {
  return delay(10_000, 30_000);
}

// Kept for use outside the scraper (e.g., Notion/OpenAI retries).
export async function politeDelay(): Promise<void> {
  return delay(3_000, 8_000);
}

export async function shortDelay(): Promise<void> {
  return delay(1_000, 3_000);
}
