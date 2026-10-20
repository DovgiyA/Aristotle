// Вид «Словарь Сети» (research R15 фичи 005): применённая версия — номер, кто подписал, когда
// применена; Старшему — подпись файла версии Ключом Координатора и подача (DICT-16, STATION-12).
// Вид Местного расширения и пометки Стоп-листа в видах — фича 011 (VIEW-50).
import type { ReactNode } from "react";
import type { Role } from "@aristotel/protocol/browser";
import type { DictionaryCurrent } from "@aristotel/protocol";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { actionsFor } from "../model/actions.ts";
import { Form, Input } from "./common.ts";
import type { DictionarySignInput } from "../model/dictionary-sign.ts";

export interface DictionaryProps {
  role: Role;
  current: DictionaryCurrent | null;
  onSign?: (input: DictionarySignInput) => void;
}

export function DictionaryView(props: DictionaryProps): ReactNode {
  const can = actionsFor(props.role).dictionary;
  const c = props.current;
  return h(
    "section",
    { "data-view": "dictionary" },
    h("h2", null, t("ui.nav.dictionary")),
    c === null
      ? h("p", null, t("ui.dictionary.none"))
      : h(
          "dl",
          null,
          h("dt", null, t("ui.dictionary.number")),
          h("dd", null, String(c.number)),
          h("dt", null, t("ui.dictionary.signed_by")),
          h("dd", null, h("code", null, c.signedBy.keyFingerprint)),
          h("dt", null, t("ui.dictionary.applied")),
          h("dd", null, `${c.appliedAt} (${c.appliedBy.label})`),
          h("dt", null, t("ui.dictionary.sha")),
          h("dd", null, h("code", null, c.bodySha256)),
        ),
    can.apply
      ? Form({
          name: "dictionary.apply",
          submit: t("ui.dictionary.sign"),
          onSubmit: (v, files) => {
            const version = files["versionFile"];
            const key = files["keyFile"];
            if (version === undefined || key === undefined) return;
            void Promise.all([version.text(), key.text()]).then(([versionText, keyFileText]) =>
              props.onSign?.({ versionText, keyFileText, keyPassword: v["keyPassword"] ?? "", password: v["password"] ?? "" }),
            );
          },
          children: [
            Input({ label: t("ui.dictionary.version_file"), name: "versionFile", type: "file", required: true }),
            Input({ label: t("ui.registry.key_file"), name: "keyFile", type: "file", required: true }),
            Input({ label: t("ui.registry.key_password"), name: "keyPassword", type: "password", required: true }),
            Input({ label: t("ui.registry.member_password"), name: "password", type: "password", required: true }),
          ],
        })
      : null,
  );
}
