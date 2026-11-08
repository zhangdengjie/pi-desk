let localSequence = 0;

export function createID(prefix: string): string {
  localSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${localSequence}`;
}

export function formatMessageTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nowLabel(): string {
  return formatMessageTime(new Date());
}
