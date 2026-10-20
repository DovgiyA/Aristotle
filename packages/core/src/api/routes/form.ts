// GET /api/form и GET /api/report-skeleton (contracts/http-api.md фичи 005; DATA-23, DATA-31 … DATA-34).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { reportSections } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { currentDictionary } from "../../dictionary/current.ts";
import { formDescription } from "../../model/form.ts";

const FormQuery = Type.Object(
  { class: Type.String({ minLength: 1 }), subtype: Type.Optional(Type.String({ minLength: 1 })), onLinux: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
const SkeletonQuery = Type.Object({ class: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function formRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get("/api/form", { schema: { querystring: FormQuery }, config: { right: "record.read" } }, async (request) => {
    const dict = currentDictionary(db);
    if (dict === undefined) throw new ApiError("dictionary_missing");
    return formDescription(dict, request.query.class, request.query.subtype, request.query.onLinux === true);
  });
  // Класс — значение item_class применённого Словаря, как у /api/form: неизвестный — 400 (T223).
  api.get("/api/report-skeleton", { schema: { querystring: SkeletonQuery }, config: { right: "record.read" } }, async (request) => {
    const dict = currentDictionary(db);
    if (dict === undefined) throw new ApiError("dictionary_missing");
    if (dict.enumValue("item_class", request.query.class) === undefined) throw new ApiError("invalid_request", { detail: `class=${request.query.class}` });
    return { sections: reportSections([request.query.class]) };
  });
}
