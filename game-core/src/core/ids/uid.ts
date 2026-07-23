let uidCounter = 0;

export function resetUidCounter(): void {
  uidCounter = 0;
}

export function nextUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}
