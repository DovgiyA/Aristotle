// T018 — SC-003: одновременные действия со Старшими не нарушают пределов — ни трёх действующих
// Старших, ни ни одного (ROLE-04, ROLE-35; research R4). Служба — отдельным процессом.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Member } from "@aristotel/protocol";
import { apiRequestAs, prepareDataDir, spawnService, type DataDir } from "../../../../tests/support/harness.ts";

const PAIRS = 100;

/** Запрос от имени Члена Группы — через сеанс его тестовой Станции (стенд фичи 004, research R19). */
async function call(data: DataDir, as: string, method: string, path: string, body?: unknown) {
  const res = await apiRequestAs(data, as, method, path, body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function members(data: DataDir): Promise<Member[]> {
  return (await call(data, data.seniorId, "GET", "/api/members")).body["items"] as Member[];
}

function activeSeniors(list: Member[]): Member[] {
  return list.filter((m) => m.role === "senior" && m.state === "active");
}

test("SC-003: 100 пар одновременных назначений при одном Старшем — Старших ровно два", async (t) => {
  const data = await prepareDataDir(t);
  const service = await spawnService(t, data);
  const c1 = data.seniorId;
  for (let i = 0; i < PAIRS; i++) {
    // Исходное состояние пары: один действующий Старший С1 и два новых Участника.
    const a = (await call(data, c1, "POST", "/api/test/members", { label: `Уa${i}` })).body["id"] as string;
    const b = (await call(data, c1, "POST", "/api/test/members", { label: `Уb${i}` })).body["id"] as string;
    const results = await Promise.all([
      call(data, c1, "PATCH", `/api/members/${a}`, { expectedVersion: 1, role: "senior" }),
      call(data, c1, "PATCH", `/api/members/${b}`, { expectedVersion: 1, role: "senior" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], `пара ${i}`);
    assert.equal(results.find((r) => r.status === 409)?.body["error"], "senior_limit");
    const seniors = activeSeniors(await members(data));
    assert.equal(seniors.length, 2, `пара ${i}`);
    // Вернуть исходное состояние: назначенный снова Участник.
    const promoted = seniors.find((m) => m.id !== c1)!;
    const back = await call(data, c1, "PATCH", `/api/members/${promoted.id}`, { expectedVersion: promoted.version, role: "participant" });
    assert.equal(back.status, 200);
  }
  await service.stop();
});

test("SC-003: 100 пар одновременных взаимных снятий двух Старших — Старший ровно один", async (t) => {
  const data = await prepareDataDir(t);
  const service = await spawnService(t, data);
  const c1 = data.seniorId;
  const s2 = (await call(data, c1, "POST", "/api/test/members", { label: "С2", role: "senior" })).body["id"] as string;
  for (let i = 0; i < PAIRS; i++) {
    const list = await members(data);
    const v1 = list.find((m) => m.id === c1)!.version;
    const v2 = list.find((m) => m.id === s2)!.version;
    const results = await Promise.all([
      call(data, c1, "PATCH", `/api/members/${s2}`, { expectedVersion: v2, role: "participant" }),
      call(data, s2, "PATCH", `/api/members/${c1}`, { expectedVersion: v1, role: "participant" }),
    ]);
    // Принят ровно один запрос. Второй отклонён: либо его автор к моменту проверки права уже снят
    // (403 forbidden — роль читается на каждом запросе), либо снятие оставило бы Группу без Старшего
    // (409 last_senior). Инвариант SC-003 — в обоих случаях.
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    assert.equal(ok.length, 1, `пара ${i}`);
    assert.ok(["last_senior", "forbidden"].includes(String(refused[0]?.body["error"])), `пара ${i}: ${JSON.stringify(refused[0]?.body)}`);
    const seniors = activeSeniors(await members(data));
    assert.equal(seniors.length, 1, `пара ${i}`);
    // Вернуть исходное состояние: оставшийся Старший снова назначает второго.
    const remaining = seniors[0]!;
    const demoted = (await members(data)).find((m) => m.id === (remaining.id === c1 ? s2 : c1))!;
    const back = await call(data, remaining.id, "PATCH", `/api/members/${demoted.id}`, { expectedVersion: demoted.version, role: "senior" });
    assert.equal(back.status, 200);
  }
  await service.stop();
});
