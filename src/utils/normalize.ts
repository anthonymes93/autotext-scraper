export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

export function dedupeArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
