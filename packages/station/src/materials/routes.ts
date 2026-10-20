// Маршруты Материалов локальной части (contracts/lokalnaya-chast.md фичи 006): регистрация, повторное
// Заверение, очередь доставки. Защита (loopback, Host, токен или cookie, CSRF) — общий хук сервера.
import type { FastifyInstance } from "fastify";
import { AttestationFormatError, isAttestation, message } from "@aristotel/protocol";
import { StationDeletedError, StationLockedError, type LocalPart } from "../local-part.ts";
import { fail } from "../http.ts";
import { MaterialFileError } from "./store.ts";
import { attachOnStation, reattestOnStation, registerOnStation, type RegisterInput, type RegisterOutcome } from "./register.ts";
import type { DeliveryQueue } from "./queue.ts";

function input(body: Record<string, unknown> | undefined): RegisterInput | undefined {
  if (typeof body?.["file"] !== "string" || typeof body["case"] !== "string") return undefined;
  const out: RegisterInput = { file: body["file"], case: body["case"] };
  if (typeof body["path"] === "string") out.path = body["path"];
  if (typeof body["kind"] === "string" || body["kind"] === null) out.kind = body["kind"] as string | null;
  return out;
}

export function materialLocalRoutes(app: FastifyInstance, part: LocalPart, queue: DeliveryQueue): void {
  const run = async (reply: Parameters<typeof fail>[0], work: () => Promise<RegisterOutcome>) => {
    let outcome: RegisterOutcome;
    try {
      outcome = await work();
    } catch (error) {
      if (error instanceof MaterialFileError) return fail(reply, error.code, { file: "" });
      if (error instanceof StationLockedError) return fail(reply, "station_locked");
      if (error instanceof StationDeletedError) return fail(reply, "station_deleted");
      if (error instanceof AttestationFormatError) return fail(reply, "attestation_invalid");
      throw error;
    }
    if ("error" in outcome) {
      if (outcome.body !== undefined) return reply.status(outcome.status).send(outcome.body);
      return fail(reply, outcome.error, outcome.params ?? {});
    }
    // Запись заведена — в очередь доставки; без связи Материал ждёт офлайн-черновика (фича 009).
    if (outcome.status === 201) queue.enqueue(outcome.id, Number(outcome.size));
    return reply.status(outcome.status).send({ id: outcome.id, sha256: outcome.sha256, size: outcome.size, record: outcome.record });
  };

  app.post<{ Body: Record<string, unknown> }>("/local/materials/register", async (request, reply) => {
    const body = input(request.body);
    if (body === undefined) return fail(reply, "invalid_request", { detail: message("detail_material_local_body") });
    return run(reply, () => registerOnStation(part, body));
  });

  app.post<{ Body: Record<string, unknown> }>("/local/materials/reattest", async (request, reply) => {
    const body = input(request.body);
    const previous = request.body?.["attestation"];
    if (body === undefined || !isAttestation(previous)) return fail(reply, body === undefined ? "invalid_request" : "attestation_invalid", { detail: message("detail_material_local_body") });
    return run(reply, () => reattestOnStation(part, { ...body, previous }));
  });

  app.get("/local/materials/queue", async () => ({ items: queue.list() }));

  // Доставка Материала, зарегистрированного на другой Станции этого Члена Группы или любой — для
  // Станции Старшего (FR-008a, T078).
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/local/materials/:id/attach", async (request, reply) => {
    const file = request.body?.["file"];
    if (typeof file !== "string") return fail(reply, "invalid_request", { detail: message("detail_material_local_body") });
    try {
      const outcome = await attachOnStation(part, request.params.id, file);
      if ("error" in outcome) {
        if (outcome.body !== undefined) return reply.status(outcome.status).send(outcome.body);
        return fail(reply, outcome.error, outcome.params ?? {});
      }
      queue.enqueue(outcome.id, Number(outcome.size), { reset: true });
      return reply.status(202).send({ id: outcome.id, size: outcome.size });
    } catch (error) {
      if (error instanceof MaterialFileError) return fail(reply, error.code, { file: "" });
      if (error instanceof StationLockedError) return fail(reply, "station_locked");
      if (error instanceof StationDeletedError) return fail(reply, "station_deleted");
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/local/materials/:id/deliver", async (request, reply) => {
    if (!queue.has(request.params.id)) return fail(reply, "not_found", { id: request.params.id });
    queue.kick(request.params.id);
    return reply.status(202).send({ id: request.params.id });
  });
}
