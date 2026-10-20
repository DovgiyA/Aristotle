// T059 фичи 004 — сценарий 9, шаг 9.14: Н1 смотрит состав Группы — видит всех Членов Группы, в том
// числе У3, — подпись, роль и состояние; менять состав не может (ROLE-36, ROLE-07, ROLE-21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { MembersView } from "../../../packages/ui/src/views/members.ts";
import { addMember } from "../../support/harness.ts";
import { startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("9.14: Н1 — состав Группы с У3, без кнопок изменения", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  addMember(net.server.db, "У3");
  const n1 = addMember(net.server.db, "Н1", "observer");
  const ui = await uiLogin(await startStation(t, net, n1));
  const members = (await ui.call("GET", "/api/members")).body["items"] as { label: string }[];
  assert.ok(members.some((m) => m.label === "У3"));
  const html = renderToString(MembersView({ role: "observer", members: members as never }) as never);
  assert.match(html, /У3/);
  assert.match(html, /Участник/);
  assert.doesNotMatch(html, /data-action="member\.(create|update|revoke)"/);
  const senior = renderToString(MembersView({ role: "senior", members: members as never }) as never);
  assert.match(senior, /data-action="member\.create"/);
  assert.equal((await ui.call("POST", "/api/members", { label: "x", role: "participant" })).body["error"], "forbidden");
});
