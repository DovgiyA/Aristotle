// Шаг 22.26: Код уникален среди элементов своего вида — тип Индикатора и перечень его значений носят
// один Код; два типа Индикаторов с одним Кодом — версия отклонена (DICT-11, DICT-64).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, nextTestVersion, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.26: os_distro — и тип Индикатора, и перечень; два типа с Кодом x — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const codes = svc.db.prepare("SELECT kind FROM dict_element WHERE code = 'os_distro' ORDER BY kind").all().map((r) => r["kind"]);
  assert.deepEqual(codes, ["enum", "indicator_type"], "один Код у элементов разных видов");
  const props = { object: T.object("operator"), format: "строка:64", comparable: false, normClass: "строка", identifying: "none", autoSecret: false };
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) =>
      b.elements.push(
        { id: "0190a000-0000-7000-8000-0000000a2601", code: "x", label: "x", kind: "indicator_type", state: "active", sinceVersion: 2, props },
        { id: "0190a000-0000-7000-8000-0000000a2602", code: "x", label: "y", kind: "indicator_type", state: "active", sinceVersion: 2, props },
      ),
    ),
  );
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", v2);
  assert.deepEqual([res.statusCode, res.json().reason], [422, "content"]);
});
