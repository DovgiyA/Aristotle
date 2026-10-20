// T059 фичи 004 — сценарий 9, шаг 9.7: С1 открывает вид «Станции» — Станция У3 «действует», виден
// последний сеанс; в журнале — начало сеанса без IP-адреса; У1 и Н1 вида «Станции» не видят
// (VIEW-47, STATION-34).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import { StationsView } from "../../../packages/ui/src/views/stations.ts";
import { addMember } from "../../support/harness.ts";
import { startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("9.7: «Станции» у С1 — У3 действует, последний сеанс; У3 вида не видит; журнал без IP", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u3 = addMember(net.server.db, "У3");
  const u3Station = await startStation(t, net, u3);
  const c1 = await uiLogin(await startStation(t, net));
  const list = await c1.call("GET", "/api/stations");
  assert.equal(list.status, 200);
  const items = list.body["items"] as { memberLabel: string; view: string; lastSession: { startedAt: string } | null }[];
  const mine = items.find((s) => s.memberLabel === "У3")!;
  assert.equal(mine.view, "active");
  assert.ok(mine.lastSession !== null);
  const html = renderToString(StationsView({ role: "senior", stations: items as never }) as never);
  assert.match(html, /У3/);
  assert.match(html, /действует/);
  const denied = await u3Station.local("GET", "/api/stations");
  assert.equal(denied.body["error"], "forbidden");
  assert.equal(renderToString((StationsView({ role: "participant", stations: items as never }) ?? "") as never), "");
  const start = net.server.db.prepare("SELECT details FROM journal WHERE action = 'station.session.start' AND actorId = ?").get(u3);
  assert.ok(start !== undefined);
  assert.doesNotMatch(String(start["details"]), /127\.0\.0\.1|::1|address|ip/i);
});
