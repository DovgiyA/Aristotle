// Подписываемое сообщение протокола: UTF-8(тег) ‖ 0x00 ‖ поле₁ ‖ 0x00 ‖ поле₂ … — строки в UTF-8,
// байтовые поля как есть (contracts/prohod-v1.md, contracts/stanciya-v1.md фичи 004). Тег не даёт
// выдать подпись одного вида за подпись другого тем же ключом.

export type MessageField = string | Uint8Array;

export function taggedMessage(tag: string, ...fields: MessageField[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode(tag)];
  for (const field of fields) {
    parts.push(new Uint8Array([0]));
    parts.push(typeof field === "string" ? encoder.encode(field) : field);
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
